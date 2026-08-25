/* The announce moment. After a mint / launch / listing succeeds, a share
   modal opens with a prewritten (editable) message and one-tap targets —
   the message carries a link to the item's public page, which unfurls with
   the actual artwork and exists to convert whoever clicks it. */
'use strict';

const Share = (() => {
  const { $, toast, escapeHtml } = UI;

  const TEMPLATES = {
    nft: (d) => `I just minted an NFT on #Koinos — no wallet setup, no gas fees, no technical experience. Check it out: ${d.url}`,
    token: (d) => `I just launched my own token ($${d.symbol}) on #Koinos with no wallet, no fees and no technical experience. Check it out: ${d.url}`,
    dex: (d) => `$${d.symbol} is now live on a #Koinos DEX with a KOIN pair — listed free, in one click. Check it out: ${d.url}`,
    wallet: (d) => `I just created a #Koinos account in one click — no signup, no seed-phrase homework, no fees. Try it yourself: ${d.url}`,
    site: (d) => `Don't read about #Koinos — use it. Mint an NFT, launch a token, all free, no wallet needed: ${d.url}`,
  };

  const HEADLINES = {
    nft: ['🎉 It’s yours, on-chain', 'Tell someone — that’s how this spreads'],
    token: ['🚀 Your token is live', 'Announce it — every token needs believers'],
    dex: ['📈 Listed and tradable', 'Tell the world there’s a market now'],
    wallet: ['🔑 You’re on Koinos', 'Know someone who should try this?'],
    site: ['Share Discover Koinos', 'The whole pitch fits in one link'],
  };

  let modal = null;
  function build() {
    if (modal) return modal;
    const d = document.createElement('dialog');
    d.className = 'modal share-modal';
    d.innerHTML = `
      <div class="share-head"><h3 id="share-title"></h3><p class="sub" id="share-sub"></p></div>
      <img id="share-img" class="share-img" alt="" hidden>
      <label class="field">Your message
        <textarea class="input" id="share-text" rows="4"></textarea>
      </label>
      <div class="share-btns">
        <a class="btn" id="share-x" target="_blank" rel="noopener"><span aria-hidden="true">𝕏</span> Post</a>
        <a class="btn ghost" id="share-tg" target="_blank" rel="noopener">Telegram</a>
        <button class="btn ghost" id="share-copy">Copy message</button>
        <button class="btn ghost" id="share-copy-link">Copy link</button>
      </div>
      <div style="text-align:right;margin-top:12px"><button class="btn ghost small" id="share-close">Not now</button></div>`;
    document.body.appendChild(d);
    modal = d;
    $('#share-close', d).addEventListener('click', () => d.close());
    $('#share-text', d).addEventListener('input', syncTargets);
    $('#share-copy', d).addEventListener('click', async () => {
      await copyText($('#share-text', d).value);
      toast('Message copied — paste it anywhere', 'ok');
    });
    $('#share-copy-link', d).addEventListener('click', async () => {
      await copyText(d.dataset.url || '');
      toast('Link copied', 'ok');
    });
    return d;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) return await navigator.clipboard.writeText(text);
      throw new Error('no clipboard');
    } catch (_) { window.prompt('Copy with Ctrl/Cmd+C, then Enter:', text); }
  }

  function syncTargets() {
    const d = modal;
    const text = $('#share-text', d).value;
    $('#share-x', d).href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
    $('#share-tg', d).href = 'https://t.me/share/url?url=' + encodeURIComponent(d.dataset.url || '') +
      '&text=' + encodeURIComponent(text.replace(d.dataset.url || '', '').trim());
  }

  /** Open the share modal. data: {url, name?, symbol?, image?} */
  function open(kind, data = {}) {
    const d = build();
    const url = data.url || location.origin + '/';
    d.dataset.url = url;
    const [title, sub] = HEADLINES[kind] || HEADLINES.site;
    $('#share-title', d).textContent = title;
    $('#share-sub', d).textContent = sub;
    const img = $('#share-img', d);
    if (data.image) { img.src = data.image; img.hidden = false; } else { img.hidden = true; }
    $('#share-text', d).value = (TEMPLATES[kind] || TEMPLATES.site)({ ...data, url });
    syncTargets();
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }

  /** The success beat: confetti now, share modal a breath later — long
      enough to see the green checks, short enough to ride the high. */
  function celebrate(kind, data, { delay = 1100 } = {}) {
    confetti();
    setTimeout(() => open(kind, data), delay);
  }

  /* ---- confetti: brief, purple, skipped for reduced-motion ---- */
  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let host = document.getElementById('confetti');
    if (!host) { host = document.createElement('div'); host.id = 'confetti'; document.body.appendChild(host); }
    const colors = ['#9966ff', '#7827e6', '#b795ff', '#ffffff', '#4ade80'];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      const size = 5 + Math.random() * 7;
      p.style.cssText = `left:${Math.random() * 100}vw;width:${size}px;height:${size * (0.4 + Math.random())}px;` +
        `background:${colors[i % colors.length]};animation-duration:${1.4 + Math.random() * 1.2}s;` +
        `animation-delay:${Math.random() * .3}s;--drift:${(Math.random() * 2 - 1) * 160}px;--spin:${Math.random() * 720 - 360}deg;`;
      host.appendChild(p);
      setTimeout(() => p.remove(), 3200);
    }
  }

  return { open, celebrate, confetti };
})();
