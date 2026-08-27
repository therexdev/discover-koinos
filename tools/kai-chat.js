/* Koinos AI chat for visitors — served by the Koinos AI NETWORK, paid for
   by this gateway's own Koinos account.

   The interesting property: there is no AI server here and none anywhere we
   run. The gateway signs each request with its chat account's key and sends
   it to the Koinos AI scheduler, which routes it to whichever volunteer
   machine on the network holds the best live model. The box this runs on
   only relays bytes — which is the point, since it has no GPU and no RAM to
   spare. Usage is metered per AI token against the chat account's balance
   at the scheduler (free daily allowance first, then deposited KAI), so
   this doubles as a live test of the network's paid consumer path.

   Authorization mirrors the desktop app exactly (scheduler /consume, wallet
   path): sha256("consume|<address>|<ts>|<JSON messages>") signed by the
   account key, base64. The scheduler recovers the address from the
   signature and bills it. The key is a WIF in KAI_CHAT_WIF — use a
   DEDICATED account holding only what the chatbot may spend, never the
   sponsor wallet: this key's only job is to authorize AI spending, and a
   leak should cost pocket money, not the mint sponsor. */
'use strict';

const crypto = require('node:crypto');
const { Signer } = require('koilib');

const K = {
  wif: '',
  scheduler: 'https://koinosai.com/scheduler',
  /* Visitors ask short questions; these bounds exist so one visitor (or a
     script) can't stuff the paid prompt. The network's own worker caps
     answers at 512 tokens — max_tokens here is a promise to the visitor,
     not the enforcement. */
  maxQuestionChars: 500,
  maxHistoryTurns: 6,
  maxHistoryChars: 1200,
};

let _signer = null, _addr = '';

function configure(opts) {
  Object.assign(K, opts || {});
  _signer = null; _addr = '';
}

const enabled = () => !!K.wif;

function signer() {
  if (!_signer && K.wif) _signer = Signer.fromWif(K.wif);
  return _signer;
}

function address() {
  if (!_addr && K.wif) _addr = signer().getAddress();
  return _addr || null;
}

/* What the bot is, in one place. Server-forced: the browser can never
   replace this, only append user turns under it. Kept compact on purpose —
   network classes run modest context windows, and every token of this
   preamble is paid for on every single question. */
const SYSTEM_PROMPT = [
  'You are Koinos AI, answering visitors on usekoinos.com — a site where people try the Koinos blockchain.',
  'You are yourself proof of what you describe: this answer is being generated on an ordinary computer somewhere on the Koinos AI network, a marketplace where people earn KOIN by serving AI from their own machines.',
  'Koinos in brief: a feeless layer-1 blockchain. Users hold Mana, which regenerates over time, so using Koinos costs no gas. KOIN is the token; VHP (Virtual Hash Power) is burned KOIN that lets a node produce blocks and earn KOIN back over time (proof of burn — no mining hardware). Smart contracts are WebAssembly, writable in AS or C++, and upgradeable. Free accounts, no wallet extension needed on this site.',
  'On this site a visitor can: create a real Koinos account in one click, mint an NFT they draw themselves, and launch their own token — all free through mana sharing.',
  'Answer briefly and plainly (a short paragraph or two). Be honest: if you are not sure of a fact, say so rather than inventing one — especially numbers and prices. Never invent links. If asked for the app, point to koinosai.com. Decline requests unrelated to helping the visitor (long essays, code dumps, roleplay) with one friendly sentence.',
].join('\n');

/* The messages array the network runs — and the array whose JSON the
   signature covers, so build it fully before signing and never touch it
   after. History is the client's own transcript replay: content is theirs
   by definition (it is a chatbot), so the bounds are about SIZE — count,
   length, and roles — never about wording. Anything malformed is dropped
   rather than 400'd: a stale tab should degrade to a fresh conversation,
   not a dead widget. */
function buildMessages(question, history) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns = Array.isArray(history) ? history.slice(-K.maxHistoryTurns) : [];
  for (const t of turns) {
    const role = t && t.role === 'assistant' ? 'assistant' : t && t.role === 'user' ? 'user' : null;
    const content = typeof t?.content === 'string' ? t.content.slice(0, K.maxHistoryChars).trim() : '';
    if (role && content) messages.push({ role, content });
  }
  messages.push({ role: 'user', content: String(question).slice(0, K.maxQuestionChars).trim() });
  return messages;
}

/* Identity fields for the scheduler's wallet-signed consume path — the
   exact shape the desktop app sends (kaiapp core/server.js signConsume):
   sha256("consume|address|ts|JSON(messages)"), signHash, base64. */
async function signConsume(messages) {
  const ts = Date.now();
  const addr = address();
  const hash = crypto.createHash('sha256')
    .update(`consume|${addr}|${ts}|${JSON.stringify(messages)}`)
    .digest();
  const sig = await signer().signHash(hash);
  return { address: addr, ts, signature: Buffer.from(sig).toString('base64') };
}

/* One network request, streamed. Returns the upstream fetch Response —
   the caller owns relaying it. "auto" = the best model class any live
   provider holds right now; billing follows the class. */
async function requestChat(messages) {
  const ident = await signConsume(messages);
  return fetch(K.scheduler.replace(/\/+$/, '') + '/consume/chat/completions', {
    method: 'POST',
    /* Fresh TCP per request: NAT/routers silently drop idle pooled
       connections, and a paid request must never be spent on a corpse
       (same field finding as the Koinos AI worker). */
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ messages, model: 'auto', stream: true, max_tokens: 512, ...ident }),
    signal: AbortSignal.timeout(190000), // big-class answers stream for minutes
  });
}

module.exports = { configure, enabled, address, buildMessages, signConsume, requestChat, SYSTEM_PROMPT, K };
