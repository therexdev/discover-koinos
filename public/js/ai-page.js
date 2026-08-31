/* Koinos AI page: a chat whose answers stream in from the Koinos AI
   network. The browser sends ONLY {question, history} — the system prompt,
   signing and spending caps all live on the gateway, so nothing a visitor
   edits here can change what gets paid for or how the bot is framed. */
'use strict';

(() => {
  const { $, escapeHtml, toast } = UI;
  UI.initHeader();

  const log = $('#chat-log');
  const form = $('#chat-form');
  const input = $('#chat-input');
  const send = $('#chat-send');
  const modelSel = $('#chat-model');
  if (!form) return;

  /* This tab's transcript, replayed to the server so the bot has context.
     In-memory only — a refresh is a fresh conversation, which is the right
     privacy default for a public demo page. */
  const history = [];
  let busy = false;

  /* Hide the whole card when the server has no chat account configured —
     an "Ask" button that always errors is worse than no button. */
  Api.config().then(cfg => {
    if (!cfg.aiChat || !cfg.aiChat.enabled) {
      $('#chat-card').innerHTML =
        '<p class="sub">The network chat isn’t switched on for this site yet — ' +
        'meanwhile you can run the same AI yourself with <a href="https://koinosai.com" target="_blank" rel="noopener">Koinos AI</a>.</p>';
    }
  }).catch(() => {});

  function addMsg(kind, who) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + kind;
    el.innerHTML = `<div class="chat-who">${escapeHtml(who)}</div><div class="chat-text"></div>`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el.querySelector('.chat-text');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const question = input.value.trim();
    if (!question) return;

    busy = true; send.disabled = true; input.disabled = true;
    addMsg('you', 'You').textContent = question;
    input.value = '';
    const out = addMsg('bot', 'Koinos AI');
    const think = (t) => { out.innerHTML = '<span class="chat-thinking"></span>'; out.firstChild.textContent = t; };
    think('finding a machine on the network…');

    /* Honest patience: a machine that has been quiet loads its model before
       the first word, which can take a minute or two. Say so instead of
       looking frozen — and give up cleanly rather than never. */
    const waitNotes = [
      setTimeout(() => { if (!answer) think('a machine is warming up its model — first answers can take a minute…'); }, 15000),
      setTimeout(() => { if (!answer) think('still working — the machine is loading a large model, hang tight…'); }, 60000),
    ];
    const ctrl = new AbortController();
    const giveUp = setTimeout(() => ctrl.abort(), 170000);

    let answer = '';
    let served = '';

    /* Models answer in markdown whether or not you ask them to, and dumping
       that into textContent showed people literal ** around their headings.
       Render it — escaping first, because the words came off a stranger's
       machine (see js/md.js). Re-rendered on every chunk so formatting
       appears as it streams; a half-finished **bold run simply shows as the
       characters it is until its closing marker arrives. */
    const paint = (text) => {
      if (window.KaiMd) {
        out.classList.add('chat-md');
        out.innerHTML = KaiMd.render(text);
      } else {
        out.textContent = text; // md.js missing: plain text beats nothing
      }
    };
    try {
      const res = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history, model: modelSel ? modelSel.value : undefined }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && j.error) || `request failed (${res.status})`);
      }

      /* SSE by hand (EventSource can't POST). Frames are the Koinos AI
         app's own OpenAI-style chunks — {choices:[{delta:{content}}]} while
         generating, then "data: [DONE]". A frame can split across network
         chunks — buffer to blank lines. */
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let f; try { f = JSON.parse(data); } catch (_) { continue; }
            if (f.servedModel) served = String(f.servedModel);
            const delta = f.choices?.[0]?.delta?.content ?? f.delta;
            if (delta) {
              answer += delta;
              paint(answer);
              log.scrollTop = log.scrollHeight;
            }
            if (f.error) throw new Error(String(f.error.message || f.error));
          }
        }
      }
      if (!answer) throw new Error('the network sent no answer — try again');
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      /* Which model actually generated this — honest provenance, and it makes
         "why was that slow/fast?" answerable at a glance. */
      if (served) {
        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        meta.textContent = `answered by ${served} — one machine on the network`;
        out.parentElement.appendChild(meta);
      }
    } catch (err) {
      /* Keep whatever streamed before the failure — half an answer plus an
         honest note beats a blank bubble. */
      const msg = err && err.name === 'AbortError'
        ? 'the network took too long this time — please ask again'
        : String(err.message || err);
      const note = document.createElement('div');
      note.className = 'chat-err';
      note.textContent = msg;
      if (!answer) out.textContent = '';
      out.parentElement.appendChild(note);
      toast(msg, 'err');
    } finally {
      waitNotes.forEach(clearTimeout);
      clearTimeout(giveUp);
      busy = false; send.disabled = false; input.disabled = false;
      input.focus();
    }
  });
})();
