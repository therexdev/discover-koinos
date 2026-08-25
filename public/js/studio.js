/* The 16×16 pixel studio. Draw with pointer events on a canvas;
   the grid is an array of palette indices (0 = transparent) that the
   server turns into a run-length SVG and puts on-chain. */
'use strict';

function PixelStudio(root) {
  const GRID = 16;
  const PALETTE = [
    'transparent',
    '#121212', '#ffffff', '#9966ff', '#5d00b3', '#7827e6',
    '#f472b6', '#ef4444', '#f97316', '#fbbf24', '#4ade80',
    '#22d3ee', '#3b82f6', '#a16207', '#6b7280',
  ];
  const cells = new Array(GRID * GRID).fill(0);
  let color = 3;                     // start on Koinos accent purple
  let tool = 'paint';                // paint | fill
  let drawing = false;
  const undoStack = [];

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = GRID; canvas.height = GRID;

  function paintCanvas() {
    ctx.clearRect(0, 0, GRID, GRID);
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      ctx.fillStyle = PALETTE[cells[i]];
      ctx.fillRect(i % GRID, Math.floor(i / GRID), 1, 1);
    }
    if (typeof focused !== 'undefined' && focused) {
      const cx = cursor % GRID, cy = Math.floor(cursor / GRID);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.15;
      ctx.strokeRect(cx + 0.08, cy + 0.08, 0.84, 0.84);
    }
  }

  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) / r.width * GRID);
    const y = Math.floor((ev.clientY - r.top) / r.height * GRID);
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return -1;
    return y * GRID + x;
  }

  function flood(start, from, to) {
    if (from === to) return;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (i < 0 || i >= cells.length || cells[i] !== from) continue;
      cells[i] = to;
      const x = i % GRID;
      if (x > 0) stack.push(i - 1);
      if (x < GRID - 1) stack.push(i + 1);
      stack.push(i - GRID, i + GRID);
    }
  }

  function snapshot() {
    undoStack.push(cells.slice());
    if (undoStack.length > 60) undoStack.shift();
  }

  function apply(ev) {
    const i = cellAt(ev);
    if (i < 0) return;
    if (tool === 'fill') { flood(i, cells[i], color); }
    else cells[i] = color;
    paintCanvas();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    snapshot();
    drawing = true;
    canvas.setPointerCapture(ev.pointerId);
    apply(ev);
  });
  canvas.addEventListener('pointermove', (ev) => { if (drawing && tool === 'paint') apply(ev); });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  /* ---- keyboard drawing (WCAG 2.1.1): arrows move a cursor, Enter/Space
     paints or fills. A small live hint announces the position. ---- */
  let cursor = 8 * GRID + 8, focused = false;
  canvas.tabIndex = 0;
  const hint = document.createElement('div');
  hint.className = 'hint'; hint.setAttribute('aria-live', 'polite');
  hint.style.textAlign = 'center';
  canvas.insertAdjacentElement('afterend', hint);
  function announce() {
    const x = cursor % GRID, y = Math.floor(cursor / GRID);
    hint.textContent = focused ? `Cursor at column ${x + 1}, row ${y + 1} — arrows move, Enter paints` : '';
  }
  canvas.addEventListener('focus', () => { focused = true; paintCanvas(); announce(); });
  canvas.addEventListener('blur', () => { focused = false; paintCanvas(); announce(); });
  canvas.addEventListener('keydown', (ev) => {
    const x = cursor % GRID, y = Math.floor(cursor / GRID);
    let nx = x, ny = y;
    if (ev.key === 'ArrowLeft') nx = Math.max(0, x - 1);
    else if (ev.key === 'ArrowRight') nx = Math.min(GRID - 1, x + 1);
    else if (ev.key === 'ArrowUp') ny = Math.max(0, y - 1);
    else if (ev.key === 'ArrowDown') ny = Math.min(GRID - 1, y + 1);
    else if (ev.key === 'Enter' || ev.key === ' ') {
      snapshot();
      if (tool === 'fill') flood(cursor, cells[cursor], color);
      else cells[cursor] = color;
      paintCanvas(); announce();
      ev.preventDefault(); return;
    } else return;
    cursor = ny * GRID + nx;
    paintCanvas(); announce();
    ev.preventDefault();
  });

  /* palette buttons */
  const pal = root.querySelector('.palette');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    if (i === 0) { b.className = 'eraser'; b.textContent = '✕'; b.title = 'Eraser (transparent)'; }
    else { b.style.background = c; b.title = c; }
    b.setAttribute('aria-label', i === 0 ? 'eraser' : 'color ' + c);
    b.setAttribute('aria-pressed', String(i === color));
    b.addEventListener('click', () => {
      color = i; tool = 'paint';
      pal.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
      modeBtns.forEach(t => t.setAttribute('aria-pressed', String(t.dataset.tool === 'paint')));
    });
    pal.appendChild(b);
  });

  /* tools. Only paint/fill are toggle (aria-pressed) buttons; undo/clear
     are momentary actions and must not claim a pressed state. */
  const toolBtns = [...root.querySelectorAll('[data-tool]')];
  const modeBtns = toolBtns.filter(b => b.dataset.tool === 'paint' || b.dataset.tool === 'fill');
  toolBtns.forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tool === 'undo') {
      if (undoStack.length) { const prev = undoStack.pop(); cells.splice(0, cells.length, ...prev); paintCanvas(); }
      return;
    }
    if (b.dataset.tool === 'clear') { snapshot(); cells.fill(0); paintCanvas(); return; }
    tool = b.dataset.tool;
    modeBtns.forEach(t => t.setAttribute('aria-pressed', String(t === b)));
  }));

  /* a friendly seed so the canvas never starts scary-blank: a tiny
     Koinos-purple diamond in the middle */
  [[7,5],[8,5],[6,6],[9,6],[5,7],[10,7],[5,8],[10,8],[6,9],[9,9],[7,10],[8,10]]
    .forEach(([x,y]) => { cells[y * GRID + x] = 3; });
  [[7,6],[8,6],[6,7],[7,7],[8,7],[9,7],[6,8],[7,8],[8,8],[9,8],[7,9],[8,9]]
    .forEach(([x,y]) => { cells[y * GRID + x] = 5; });
  paintCanvas();

  return {
    grid: () => cells.slice(),
    palette: () => PALETTE.map(c => c === 'transparent' ? '#000000' : c), // index 0 unused server-side
    isEmpty: () => cells.every(v => v === 0),
    clear: () => { cells.fill(0); paintCanvas(); },
  };
}
