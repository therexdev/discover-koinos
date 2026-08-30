/* ============================================================
   Outbound email, over fetch — no new dependency.

   The gateway needs to tell someone "a stranger sent you an NFT, come and
   claim it". That is the only job here, so this stays a thin sender with
   three shapes of provider behind one call:

     · Resend      EMAIL_PROVIDER=resend    + EMAIL_API_KEY
     · SendGrid    EMAIL_PROVIDER=sendgrid  + EMAIL_API_KEY
     · anything    EMAIL_WEBHOOK_URL — we POST the message as JSON and
                   whatever is on the other end does the sending

   Unconfigured, it logs the message and reports itself disabled rather than
   throwing: a gift must still be sendable and claimable on a server with no
   mail set up. The claim link in the log is a real, working link.
   ============================================================ */
'use strict';

const RETRYABLE = /^(408|409|425|429|5\d\d)$/;

function createMailer(cfg = {}) {
  const provider = String(cfg.provider || '').trim().toLowerCase();
  const apiKey = String(cfg.apiKey || '').trim();
  const webhook = String(cfg.webhookUrl || '').trim();
  const from = String(cfg.from || '').trim();
  const fromName = String(cfg.fromName || 'Discover Koinos').trim();
  const log = cfg.log || console.log;

  function enabled() {
    if (webhook) return true;
    return !!(apiKey && from && (provider === 'resend' || provider === 'sendgrid'));
  }

  /** Why email is off, in words an operator can act on. */
  function status() {
    if (webhook) return { enabled: true, via: 'webhook' };
    if (!provider) return { enabled: false, why: 'EMAIL_PROVIDER is not set (resend | sendgrid), and no EMAIL_WEBHOOK_URL' };
    if (provider !== 'resend' && provider !== 'sendgrid') return { enabled: false, why: `unknown EMAIL_PROVIDER "${provider}" — use resend or sendgrid` };
    if (!apiKey) return { enabled: false, why: 'EMAIL_API_KEY is not set' };
    if (!from) return { enabled: false, why: 'EMAIL_FROM is not set' };
    return { enabled: true, via: provider };
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

  return { send, enabled, status };
}

module.exports = { createMailer };
