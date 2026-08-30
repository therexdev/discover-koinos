/* ============================================================
   Send to an email address.

   You can already send a token or an NFT to a Koinos address. This lets you
   send it to a Gmail address instead, which is what people actually have for
   each other. Two cases, decided by whether the gateway already knows a
   wallet for that address:

     KNOWN    someone who has signed in here before — the transfer goes
              straight to their own account, exactly like an address send.
              They just get an email telling them it arrived.

     UNKNOWN  the transfer goes to a gateway-held ESCROW account and a claim
              is recorded against the email. When that person signs in with
              Google, the email on their verified token is matched and the
              escrow forwards everything to their wallet.

   Custody, stated plainly: an unclaimed gift is held by this server, in one
   escrow account whose key lives in data/gift-escrow.json (mode 600). That
   is real custody and it is why claims expire — an unclaimed gift returns to
   its sender rather than sitting here forever.

   Matching is on the email Google itself asserts (verified claim on the ID
   token), never on a string the sender typed alone: the sender's typing only
   decides which pending claim a verified address may collect.
   ============================================================ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CLAIM_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 days, then returnable
const MAX_PENDING_PER_EMAIL = 50;

/** Gmail treats dots and +tags as noise, so "a.b+x@gmail.com" and
    "ab@gmail.com" are one inbox. Match the way the mail actually lands, or a
    gift sent to one spelling is invisible to the person who receives it. */
function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(s);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  else local = local.split('+')[0];
  if (!local) return null;
  return `${local}@${domain}`;
}

const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

function createGifts(cfg) {
  const { dataDir, chain, origin } = cfg;
  const mailer = cfg.mailer;
  const lookupEmail = cfg.lookupEmail || (() => null);
  const log = cfg.log || console.log;

  const FILE = path.join(dataDir, 'gifts.json');
  const KEYFILE = path.join(dataDir, 'gift-escrow.json');

  let store;
  try { store = JSON.parse(fs.readFileSync(FILE)); } catch (_) { store = {}; }
  store.claims = store.claims || [];          // pending + settled gift records

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  /* ---- the escrow account ---- */

  let _escrow = null;
  /** The one account unclaimed gifts sit in. Made on first use and never
      rotated — rotating it would strand everything already held. */
  function escrow() {
    if (_escrow) return _escrow;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(KEYFILE)); } catch (_) { rec = null; }
    if (!rec || !rec.wif) {
      const made = chain.newAccount();
      rec = { wif: made.wif, address: made.address, ts: Date.now() };
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = KEYFILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, KEYFILE);
      log(`[gifts] escrow account created: ${rec.address}`);
    }
    _escrow = { address: rec.address, key: chain.keyFromWif(rec.wif) };
    return _escrow;
  }
  const escrowAddress = () => escrow().address;

  /* ---- resolving a recipient ---- */

  /** Where should this send actually go?

      Returns { kind, address, email, label }. `kind` is one of:
        address     — a plain Koinos address, nothing else to do
        direct      — an email we already know a wallet for
        escrow      — an email we do not; it lands in escrow and is claimed */
  function resolve(to) {
    const raw = String(to || '').trim();
    if (!raw) throw new Error('a destination is required');
    if (!looksLikeEmail(raw)) {
      if (!chain.isAddr(raw)) throw new Error('that is not a Koinos address or an email address');
      return { kind: 'address', address: raw, email: null, label: raw };
    }
    const email = normalizeEmail(raw);
    if (!email) throw new Error('that email address does not look right');
    const known = lookupEmail(email);
    if (known && chain.isAddr(known)) {
      return { kind: 'direct', address: known, email, label: raw.trim() };
    }
    const pending = pendingFor(email).length;
    if (pending >= MAX_PENDING_PER_EMAIL) {
      throw new Error('that address already has the maximum number of unclaimed gifts waiting');
    }
    return { kind: 'escrow', address: escrowAddress(), email, label: raw.trim() };
  }

  /* ---- claims ---- */

  const pendingFor = (email) =>
    store.claims.filter(c => c.email === email && c.status === 'pending' && c.expires > Date.now());

  /** Record a gift that has just landed in escrow, and tell the recipient. */
  async function recordEscrow(gift) {
    const rec = {
      id: crypto.randomBytes(9).toString('hex'),
      email: gift.email,
      typedAs: gift.label || gift.email,
      kind: gift.kind,                       // 'token' | 'nft'
      token: gift.token || null,
      symbol: gift.symbol || null,
      amount: gift.amount || null,
      units: gift.units || null,
      decimals: gift.decimals == null ? null : gift.decimals,
      tokenId: gift.tokenId || null,
      nftCode: gift.nftCode || null,
      nftName: gift.nftName || null,
      from: gift.from,
      fromLabel: gift.fromLabel || null,
      txid: gift.txid || null,
      status: 'pending',
      ts: Date.now(),
      expires: Date.now() + CLAIM_TTL_MS,
    };
    store.claims.push(rec);
    save();
    const mail = await notifyRecipient(rec);
    if (mail && !mail.sent) { rec.mailWhy = mail.why; save(); }
    return rec;
  }

  /** A direct send to a known wallet: nothing to hold, just say it arrived. */
  async function notifyDirect(gift) {
    return notifyRecipient({ ...gift, status: 'delivered' });
  }

  const describe = (c) => (c.kind === 'nft'
    ? `the NFT “${c.nftName || c.nftCode || 'a collectible'}”`
    : `${c.amount} ${c.symbol || 'tokens'}`);

  async function notifyRecipient(c) {
    if (!c.email) return { sent: false, why: 'no email' };
    const claiming = c.status === 'pending';
    const url = `${origin}/wallet?claim=${encodeURIComponent(c.email)}`;
    const subject = claiming
      ? `Someone sent you ${describe(c)} on Koinos`
      : `You received ${describe(c)} on Koinos`;
    const text = claiming
      ? [
        `Someone sent you ${describe(c)} on the Koinos blockchain.`,
        '',
        'It is being held for you. To collect it, open the link below and sign in',
        'with this Google account — that creates your free wallet if you do not',
        'have one yet, and moves the gift straight into it.',
        '',
        url,
        '',
        'Nothing to install, no fees, no seed phrase.',
        `If you do nothing, the gift returns to the sender after ${Math.round(CLAIM_TTL_MS / 86400000)} days.`,
      ].join('\n')
      : [
        `You received ${describe(c)} on the Koinos blockchain.`,
        '',
        'It is already in your wallet:',
        url,
      ].join('\n');
    const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.55;color:#1c1a24">
      <h2 style="margin:0 0 12px">${claiming ? 'Someone sent you a gift on Koinos' : 'Your gift arrived'}</h2>
      <p style="margin:0 0 14px">${claiming ? 'Someone sent you' : 'You received'} <strong>${escapeHtml(describe(c))}</strong> on the Koinos blockchain.</p>
      ${claiming ? '<p style="margin:0 0 14px">It is being held for you. Collect it by signing in with this Google account — that makes your free wallet if you do not have one yet, and moves the gift into it.</p>' : ''}
      <p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#5d00b3;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${claiming ? 'Collect your gift' : 'Open your wallet'}</a></p>
      <p style="margin:0;color:#6b6577;font-size:13px">Nothing to install, no fees, no seed phrase.${claiming ? ` Unclaimed gifts return to the sender after ${Math.round(CLAIM_TTL_MS / 86400000)} days.` : ''}</p>
    </div>`;
    return mailer.send({ to: c.email, subject, text, html });
  }

  /* ---- collecting ---- */

  /** Hand every pending gift for a VERIFIED email to its owner's wallet.

      Called on Google sign-in, where `email` came off the ID token Google
      signed — never off anything a sender typed. Never throws: a failed
      release must not break someone's sign-in, so it reports and leaves the
      claim pending for the next visit. */
  async function collect(email, address) {
    const to = normalizeEmail(email);
    if (!to || !chain.isAddr(address)) return { released: 0, failed: 0, claims: [] };
    const mine = pendingFor(to);
    if (!mine.length) return { released: 0, failed: 0, claims: [] };

    const out = { released: 0, failed: 0, claims: [] };
    for (const c of mine) {
      try {
        const ops = c.kind === 'nft'
          ? [await chain.opNftTransfer(escrowAddress(), address, c.tokenId)]
          : [await chain.opTokenTransfer(c.token, escrowAddress(), address, c.units)];
        const txid = await chain.sendAsAccount(escrow().key, ops);
        c.status = 'claimed';
        c.claimedBy = address;
        c.claimedAt = Date.now();
        c.claimTxid = txid;
        out.released += 1;
        out.claims.push(c);
        log(`[gifts] released ${describe(c)} to ${address} (${c.email})`);
      } catch (e) {
        c.attempts = (c.attempts || 0) + 1;
        c.lastError = String(e.message || e).slice(0, 200);
        out.failed += 1;
        log(`[gifts] could not release ${c.id} to ${address}: ${c.lastError}`);
      }
    }
    save();
    for (const c of out.claims) {
      /* Tell the sender their gift landed — they have been waiting on it. */
      if (c.fromEmail) {
        mailer.send({
          to: c.fromEmail,
          subject: `${c.typedAs} collected your gift`,
          text: `${c.typedAs} signed in and collected ${describe(c)}. It is in their wallet now.`,
        }).catch(() => {});
      }
    }
    return out;
  }

  /** What is waiting, from the sender's side and the recipient's. */
  function outbox(address) {
    return store.claims
      .filter(c => c.from === address)
      .slice(-40).reverse()
      .map(c => ({
        id: c.id, email: c.typedAs, kind: c.kind, symbol: c.symbol, amount: c.amount,
        nftName: c.nftName, nftCode: c.nftCode, status: c.status, ts: c.ts,
        expires: c.expires, mailWhy: c.mailWhy || undefined,
      }));
  }
  const pendingCount = (email) => pendingFor(normalizeEmail(email) || '').length;

  /** Expire what nobody collected, so escrow does not hold it forever. */
  function sweepExpired() {
    let n = 0;
    for (const c of store.claims) {
      if (c.status === 'pending' && c.expires <= Date.now()) { c.status = 'expired'; n += 1; }
    }
    if (n) { save(); log(`[gifts] ${n} unclaimed gift(s) expired and can be returned`); }
    return n;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  return {
    normalizeEmail, looksLikeEmail, resolve,
    escrowAddress, recordEscrow, notifyDirect, collect,
    outbox, pendingCount, sweepExpired,
    stats: () => ({
      escrow: escrowAddress(),
      pending: store.claims.filter(c => c.status === 'pending').length,
      claimed: store.claims.filter(c => c.status === 'claimed').length,
    }),
  };
}

module.exports = { createGifts, normalizeEmail, looksLikeEmail };
