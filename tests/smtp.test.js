/* Does the mailer actually speak SMTP?

   The gift emails are the whole point of sending to an address nobody has a
   wallet for, so "we sent it" has to mean a server accepted it. This runs a
   real (tiny) SMTP server on localhost and checks the conversation the mailer
   holds with it: that it authenticates, addresses the envelope correctly, and
   that the message which arrives carries the subject, the claim link and both
   a text and an HTML part.

   Also checked: a rejection is REPORTED, not swallowed — a gift that is
   already on-chain must never be described as emailed when it was not.

   Run: node tests/smtp.test.js
*/
'use strict';
const assert = require('node:assert');
const net = require('node:net');
const { createMailer } = require('../tools/mailer');

/** A minimal SMTP server: enough of the protocol to be talked to for real. */
function smtpServer({ rejectAuth = false, rejectData = false } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    let inData = false;
    let msg = { rcpt: [], body: '' };
    const say = (s) => sock.write(s + '\r\n');
    say('220 test.local ESMTP ready');
    sock.on('data', (chunk) => {
      for (const raw of chunk.toString('utf8').split('\r\n')) {
        if (inData) {
          if (raw === '.') {
            inData = false;
            if (rejectData) { say('550 message rejected'); continue; }
            received.push(msg);
            msg = { rcpt: [], body: '' };
            say('250 OK queued');
          } else {
            /* dot-stuffing: a leading '..' on the wire is a literal '.' */
            msg.body += (raw.startsWith('..') ? raw.slice(1) : raw) + '\n';
          }
          continue;
        }
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') { say('250-test.local'); say('250 AUTH PLAIN LOGIN'); }
        else if (cmd === 'AUTH') {
          if (rejectAuth) { say('535 authentication failed'); continue; }
          const plain = /^AUTH\s+PLAIN\s+(\S+)$/i.exec(line);
          if (plain) {
            /* AUTH PLAIN carries \0user\0pass in one base64 blob. */
            const parts = Buffer.from(plain[1], 'base64').toString('utf8').split('\0');
            msg.auth = [parts[1], parts[2]];
            say('235 authenticated');
          } else if (/AUTH\s+LOGIN\s*$/i.test(line)) say('334 VXNlcm5hbWU6');
          else say('235 authenticated');
        }
        else if (/^[A-Za-z0-9+/=]+$/.test(line) && !cmd.match(/^(MAIL|RCPT|DATA|QUIT|RSET|NOOP)$/)) {
          /* an AUTH LOGIN continuation: user, then password */
          msg.auth = (msg.auth || []).concat(Buffer.from(line, 'base64').toString('utf8'));
          say(msg.auth.length >= 2 ? '235 authenticated' : '334 UGFzc3dvcmQ6');
        }
        else if (cmd === 'MAIL') { msg.from = /<(.*)>/.exec(line)?.[1]; say('250 OK'); }
        else if (cmd === 'RCPT') { msg.rcpt.push(/<(.*)>/.exec(line)?.[1]); say('250 OK'); }
        else if (cmd === 'DATA') { inData = true; say('354 send it'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, received, close: () => server.close() }));
  });
}

const mailerFor = (port, extra = {}) => createMailer({
  provider: 'smtp', smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false,
  smtpUser: 'hello@usekoinos.com', smtpPass: 'hunter2',
  fromName: 'Discover Koinos', log: () => {}, ...extra,
});

/** Read the Subject header back the way a mail client does: unfold the
    continuation lines, then undo RFC 2047 Q/B encoding. */
function decodeSubject(body) {
  const m = /^Subject: ((?:.*\n(?: |\t).*)*.*)$/m.exec(body);
  if (!m) return null;
  return m[1].split('\n').map(x => x.trim()).join('')
    .replace(/\?=\s*=\?[^?]+\?[QqBb]\?/g, '')          // join adjacent words
    .replace(/^=\?[^?]+\?([QqBb])\?/, (_, k) => (kind = k, ''))
    .replace(/\?=$/, '')
    .replace(/_/g, ' ')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[\u0080-\u00ff]+/g, (r) => Buffer.from(r, 'binary').toString('utf8'));
}
let kind = 'Q';

const GIFT = {
  to: 'friend@gmail.com',
  subject: 'Someone sent you the NFT “Pixel Cat” on Koinos',
  text: 'Someone sent you a gift.\n\nhttps://usekoinos.com/wallet?claim=friend@gmail.com\n',
  html: '<p>Someone sent you a gift.</p><a href="https://usekoinos.com/wallet?claim=friend@gmail.com">Collect</a>',
};

(async () => {
  /* --- 1. a real SMTP conversation, and the right message at the end --- */
  {
    const srv = await smtpServer();
    const mailer = mailerFor(srv.port);
    assert.strictEqual(mailer.enabled(), true, 'SMTP config alone must enable email');
    assert.match(mailer.status().via, /^smtp 127\.0\.0\.1:/);

    const ok = await mailer.verify();
    assert.strictEqual(ok.enabled, true, 'verify() must log in before anything is sent');

    const res = await mailer.send(GIFT);
    assert.deepStrictEqual(res, { sent: true });
    assert.strictEqual(srv.received.length, 1, 'exactly one message reached the server');

    const m = srv.received[0];
    assert.strictEqual(m.from, 'hello@usekoinos.com', 'the mailbox is the envelope sender');
    assert.deepStrictEqual(m.rcpt, ['friend@gmail.com']);
    assert.deepStrictEqual(m.auth, ['hello@usekoinos.com', 'hunter2'], 'it authenticated with the mailbox credentials');
    assert.match(m.body, /^From: .*Discover Koinos.* <hello@usekoinos\.com>/m, 'From carries the display name');
    assert.match(m.body, /^To: friend@gmail\.com/m);
    assert.match(m.body, /multipart\/alternative/, 'text and HTML both go, so any client can read it');
    assert.match(m.body, /Content-Type: text\/plain/);
    assert.match(m.body, /Content-Type: text\/html/);
    /* The claim link is the point of the whole email — it must arrive
       readable, not mangled by encoding. */
    assert.match(m.body, /https:\/\/usekoinos\.com\/wallet\?claim=friend@gmail\.com/,
      'the claim link arrives intact');
    assert.match(m.body, /Collect<\/a>/, 'and the HTML part carries its button');
    /* The subject has a smart quote, so it rides as RFC 2047 across folded
       lines. Decode it the way a mail client would. */
    assert.strictEqual(decodeSubject(m.body), GIFT.subject,
      'the subject decodes back to exactly what we sent, smart quotes and all');
    srv.close();
    console.log('✓ authenticates, addresses the envelope, and delivers subject + claim link as text and HTML');
  }

  /* --- 2. a refused login is reported, never silently "sent" --- */
  {
    const srv = await smtpServer({ rejectAuth: true });
    const mailer = mailerFor(srv.port);
    const v = await mailer.verify();
    assert.strictEqual(v.enabled, false, 'a bad password must surface at boot');
    assert.match(v.why, /SMTP login failed/);
    const res = await mailer.send(GIFT);
    assert.strictEqual(res.sent, false, 'and nothing may claim to have been sent');
    assert.match(res.why, /SMTP/);
    srv.close();
    console.log('✓ a refused login fails verify() and fails the send, with the reason');
  }

  /* --- 3. a refused message is reported too --- */
  {
    const srv = await smtpServer({ rejectData: true });
    const res = await mailerFor(srv.port).send(GIFT);
    assert.strictEqual(res.sent, false);
    assert.match(res.why, /SMTP/);
    srv.close();
    console.log('✓ a rejected message is reported, not swallowed');
  }

  /* --- 4. the Titan defaults, and what is still missing --- */
  {
    const bare = createMailer({ provider: 'smtp', smtpUser: 'hello@usekoinos.com', smtpPass: 'x', log: () => {} });
    assert.strictEqual(bare.enabled(), true, 'host and port default to Titan; user + pass are enough');
    assert.match(bare.status().via, /smtp\.titan\.email:465 \(TLS\) as hello@usekoinos\.com/);

    const noPass = createMailer({ provider: 'smtp', smtpUser: 'hello@usekoinos.com', log: () => {} });
    assert.strictEqual(noPass.enabled(), false);
    assert.match(noPass.status().why, /SMTP_PASS/);

    /* 587 is STARTTLS, 465 is implicit TLS — inferred, not configured. */
    const starttls = createMailer({ provider: 'smtp', smtpPort: '587', smtpUser: 'a@b.com', smtpPass: 'x', log: () => {} });
    assert.match(starttls.status().via, /:587 \(STARTTLS\)/);
    console.log('✓ Titan defaults need only user + pass; port picks its own TLS mode');
  }

  /* --- 5. unconfigured still lets a gift happen --- */
  {
    const off = createMailer({ log: () => {} });
    assert.strictEqual(off.enabled(), false);
    const res = await off.send(GIFT);
    assert.strictEqual(res.sent, false);
    assert.match(res.why, /not configured/);
    console.log('✓ with no mail configured, sending reports it instead of throwing');
  }

  console.log('\nALL SMTP CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
