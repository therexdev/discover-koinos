/* ============================================================
   Outbound email.

   The gateway needs to tell someone "a stranger sent you an NFT, come and
   claim it". That is the only job here, so this stays a thin sender with
   four shapes of provider behind one call:

     · SMTP        EMAIL_PROVIDER=smtp — a real mailbox (Hostinger Titan,
                   Google Workspace, anything). SMTP_HOST/PORT/USER/PASS
     · Resend      EMAIL_PROVIDER=resend    + EMAIL_API_KEY
     · SendGrid    EMAIL_PROVIDER=sendgrid  + EMAIL_API_KEY
     · anything    EMAIL_WEBHOOK_URL — we POST the message as JSON and
                   whatever is on the other end does the sending

   The HTTP providers go over fetch. SMTP goes through nodemailer, which is
   the one dependency here worth taking: TLS negotiation, AUTH mechanisms,
   MIME assembly, dot-stuffing and header encoding are all places a
   hand-rolled client quietly gets it wrong, and mail that silently fails to
   arrive is the worst kind of bug for a feature whose whole point is
   reaching someone who does not know you yet.

   Unconfigured, it logs the message and reports itself disabled rather than
   throwing: a gift must still be sendable and claimable on a server with no
   mail set up. The claim link in the log is a real, working link.
   ============================================================ */
'use strict';

const RETRYABLE = /^(408|409|425|429|5\d\d)$/;

/* Hostinger Titan, the mailbox this gateway actually uses. Named here so
   hosting only needs the password — every other value has a right answer. */
const SMTP_DEFAULTS = { host: 'smtp.titan.email', port: 465 };

function createMailer(cfg = {}) {
  const provider = String(cfg.provider || '').trim().toLowerCase();
  const apiKey = String(cfg.apiKey || '').trim();
  const webhook = String(cfg.webhookUrl || '').trim();
  const fromName = String(cfg.fromName || 'Discover Koinos').trim();
  const log = cfg.log || console.log;

  const smtp = {
    host: String(cfg.smtpHost || '').trim() || SMTP_DEFAULTS.host,
    port: parseInt(cfg.smtpPort || SMTP_DEFAULTS.port, 10),
    user: String(cfg.smtpUser || '').trim(),
    pass: String(cfg.smtpPass || ''),
    /* Implicit TLS on 465, STARTTLS on 587/25 — the rule every provider
       follows, so nobody has to set a flag that only has one right value. */
    secure: cfg.smtpSecure == null ? parseInt(cfg.smtpPort || SMTP_DEFAULTS.port, 10) === 465 : !!cfg.smtpSecure,
  };
  /* An SMTP mailbox IS an address, so it is the From unless told otherwise —
     and with most providers it has to be, or the mail is rejected. */
  const from = String(cfg.from || '').trim() || (provider === 'smtp' ? smtp.user : '');

  function enabled() {
    if (webhook) return true;
    if (provider === 'smtp') return !!(smtp.host && smtp.user && smtp.pass && from);
    return !!(apiKey && from && (provider === 'resend' || provider === 'sendgrid'));
  }

  /** Why email is off, in words an operator can act on. */
  function status() {
    if (webhook) return { enabled: true, via: 'webhook' };
    if (!provider) return { enabled: false, why: 'EMAIL_PROVIDER is not set (smtp | resend | sendgrid), and no EMAIL_WEBHOOK_URL' };
    if (provider === 'smtp') {
      if (!smtp.user) return { enabled: false, why: 'SMTP_USER is not set (the full mailbox address)' };
      if (!smtp.pass) return { enabled: false, why: 'SMTP_PASS is not set' };
      if (!from) return { enabled: false, why: 'EMAIL_FROM is not set' };
      return { enabled: true, via: `smtp ${smtp.host}:${smtp.port}${smtp.secure ? ' (TLS)' : ' (STARTTLS)'} as ${smtp.user}` };
    }
    if (provider !== 'resend' && provider !== 'sendgrid') return { enabled: false, why: `unknown EMAIL_PROVIDER "${provider}" — use smtp, resend or sendgrid` };
    if (!apiKey) return { enabled: false, why: 'EMAIL_API_KEY is not set' };
    if (!from) return { enabled: false, why: 'EMAIL_FROM is not set' };
    return { enabled: true, via: provider };
  }

  /* One pooled transport, built on first use so a server with no mail
     configured never loads nodemailer at all. */
  let _tx = null;
  function transport() {
    if (!_tx) {
      const nodemailer = require('nodemailer');
      _tx = nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        pool: true, maxConnections: 2,
        connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
      });
    }
    return _tx;
  }

  async function sendSmtp(msg) {
    try {
      await transport().sendMail({
        from: { name: fromName, address: from },
        to: msg.to, subject: msg.subject,
        text: msg.text, html: msg.html || undefined,
      });
      return { sent: true };
    } catch (e) {
      /* A wrong password or a blocked port is a config problem the operator
         must see, not a blip to swallow — nodemailer already retried the
         parts worth retrying. */
      log(`[mail] SMTP send to ${msg.to} failed: ${e.message}`);
      return { sent: false, why: `SMTP: ${String(e.message || e).slice(0, 160)}` };
    }
  }

  /** Prove the mailbox works without sending anything, so a bad password
      shows up in the boot log instead of in a missed gift. */
  async function verify() {
    if (provider !== 'smtp' || !enabled()) return status();
    try { await transport().verify(); return { enabled: true, via: status().via }; }
    catch (e) { return { enabled: false, why: `SMTP login failed: ${String(e.message || e).slice(0, 160)}` }; }
  }

  function request(msg) {
    if (webhook) {
      return { url: webhook, headers: { 'Content-Type': 'application/json' }, body: { ...msg, from, fromName } };
    }
    if (provider === 'resend') {
      return {
        url: 'https://api.resend.com/emails',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: { from: `${fromName} <${from}>`, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html },
      };
    }
    return {
      url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: {
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from, name: fromName },
        subject: msg.subject,
        content: [{ type: 'text/plain', value: msg.text }, { type: 'text/html', value: msg.html || msg.text }],
      },
    };
  }

  /** Send one message. Never throws: a gift that is already on-chain must
      not be reported as failed because a mail API had a bad minute. Returns
      { sent, why } so the caller can record what happened. */
  async function send(msg) {
    if (!msg || !msg.to || !msg.subject) return { sent: false, why: 'incomplete message' };
    if (!enabled()) {
      log(`[mail] (not configured — ${status().why}) would send to ${msg.to}: ${msg.subject}`);
      if (msg.text) log(`[mail]   ${msg.text.split('\n').filter(Boolean).join(' | ').slice(0, 300)}`);
      return { sent: false, why: 'email is not configured on this server' };
    }
    if (provider === 'smtp' && !webhook) return sendSmtp(msg);
    const req = request(msg);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 500 * attempt * attempt));
      try {
        const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
        if (res.ok) return { sent: true };
        const detail = await res.text().catch(() => '');
        if (!RETRYABLE.test(String(res.status))) {
          log(`[mail] ${res.status} sending to ${msg.to}: ${detail.slice(0, 200)}`);
          return { sent: false, why: `mail provider refused it (${res.status})` };
        }
      } catch (e) {
        if (attempt === 2) {
          log(`[mail] could not reach the mail provider: ${e.message}`);
          return { sent: false, why: 'could not reach the mail provider' };
        }
      }
    }
    return { sent: false, why: 'the mail provider kept failing' };
  }

  return { send, enabled, status, verify };
}

module.exports = { createMailer };
