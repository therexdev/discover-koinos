/* Koinos AI chat for visitors — answered through the site owner's OWN
   Koinos AI app (the desktop app running on their computer), not through
   anything special built for this site.

   The app already serves an OpenAI-compatible API (default port 41100,
   /v1/chat/completions, Authorization: Bearer <api key> — keys are made in
   the app). With a "koinos-network:<class>" model the app signs the request
   with its own earning account and the Koinos AI scheduler routes it to a
   machine serving that class — so the weak box this site runs on only
   relays bytes, and usage is billed to the app's account per AI token,
   exactly like any other consumer of that API.

   This module is deliberately nothing more than that: build the prompt,
   call the owner's API, hand back the stream. KAI_API_URL points at the
   device (through whatever tunnel or port-forward exposes it) and
   KAI_API_KEY is a key minted in the app — never a wallet key. */
'use strict';

/* The classes a visitor may pick. A closed list, mapped server-side to the
   app's "koinos-network:<class>" form — the browser sends only an id from
   this list, so nobody can point the owner's paid account at a pricier
   class than these. Balanced is the default: the network's common model,
   served by more machines than the big ones. */
const MODEL_CHOICES = [
  { id: 'koinos-fast', label: '⚡ Fast', hint: 'quickest, simplest answers' },
  { id: 'koinos-balanced', label: '⚖️ Balanced', hint: 'good answers at a good pace' },
  { id: 'koinos-smart', label: '🧠 Smart', hint: 'deepest answers, slower' },
];
const MODEL_MAP = Object.fromEntries(MODEL_CHOICES.map(c => [c.id, 'koinos-network:' + c.id]));

const K = {
  url: '',
  key: '',
  model: 'koinos-network:koinos-balanced', // fallback when the request names no (valid) choice
  /* Visitors ask short questions; these bounds exist so one visitor (or a
     script) can't stuff the paid prompt. max_tokens bounds the answer the
     same way. */
  maxQuestionChars: 500,
  maxHistoryTurns: 6,
  maxHistoryChars: 1200,
};

function configure(opts) {
  Object.assign(K, opts || {});
  /* The app's own snippet shows its base URL ending in /v1 (OpenAI-SDK
     style); we append the full /v1/... path ourselves — accept either. */
  K.url = String(K.url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

const enabled = () => !!K.url;

/* What the bot is, in one place. Server-forced: the browser can never
   replace this, only append user turns under it. Kept compact on purpose —
   every token of this preamble rides on every single question. */
const SYSTEM_PROMPT = [
  'You are Koinos AI, answering visitors on usekoinos.com — a site where people try the Koinos blockchain.',
  'You are yourself proof of what you describe: this answer is being generated through the Koinos AI network, a marketplace where people earn KOIN by serving AI from their own machines.',
  'Koinos in brief: a feeless layer-1 blockchain. Users hold Mana, which regenerates over time, so using Koinos costs no gas. KOIN is the token; VHP (Virtual Hash Power) is burned KOIN that lets a node produce blocks and earn KOIN back over time (proof of burn — no mining hardware). Smart contracts are WebAssembly, writable in AS or C++, and upgradeable. Free accounts, no wallet extension needed on this site.',
  'On this site a visitor can: create a real Koinos account in one click, mint an NFT they draw themselves, and launch their own token — all free through mana sharing.',
  'Answer briefly and plainly (a short paragraph or two). Be honest: if you are not sure of a fact, say so rather than inventing one — especially numbers and prices. Never invent links. If asked for the app, point to koinosai.com. Decline requests unrelated to helping the visitor (long essays, code dumps, roleplay) with one friendly sentence.',
].join('\n');

/* The messages array the model runs. History is the client's own
   transcript replay: content is theirs by definition (it is a chatbot), so
   the bounds are about SIZE — count, length, and roles — never about
   wording. Anything malformed is dropped rather than 400'd: a stale tab
   should degrade to a fresh conversation, not a dead widget. */
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

/* One request to the owner's app, streamed. Returns the upstream fetch
   Response — the caller owns relaying it. The app answers with standard
   OpenAI-style SSE chunks ending in "data: [DONE]". */
async function requestChat(messages, modelChoice) {
  const model = MODEL_MAP[modelChoice] || K.model;
  return fetch(K.url + '/v1/chat/completions', {
    method: 'POST',
    /* Fresh TCP per request: NAT/routers silently drop idle pooled
       connections, and a request must never be spent on a corpse (same
       field finding as the Koinos AI worker). */
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      ...(K.key ? { authorization: `Bearer ${K.key}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 512 }),
    signal: AbortSignal.timeout(190000), // network answers can stream for minutes
  });
}

module.exports = { configure, enabled, buildMessages, requestChat, SYSTEM_PROMPT, K, MODEL_CHOICES };
