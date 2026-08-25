/* Zero-dependency PNG writer — enough to turn 16×16 pixel art into the
   raster social cards X/Telegram/Discord demand (they won't unfurl SVG).
   RGBA, no filtering, zlib via node's own zlib. */
'use strict';
const zlib = require('node:zlib');

/* ---- CRC32 (PNG chunk checksums) ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgba: Buffer of width*height*4. Returns a complete PNG buffer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // raw scanlines: filter byte 0 + row
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- tiny drawing surface ---- */
function surface(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  function set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  function fillRect(x, y, w, h, c) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c);
  }
  return { width, height, rgba, set, fillRect, png: () => encodePng(width, height, rgba) };
}

const hexRgb = (hex) => {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/** The social card for a painted NFT: 1200×630, Koinos-purple vertical
    gradient, the 16×16 art centered and scaled with crisp cells. */
function nftCardPng(palette, cells, grid = 16) {
  const W = 1200, H = 630;
  const s = surface(W, H);
  const top = hexRgb('#1a1229'), bottom = hexRgb('#120d1c');
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const c = [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t), 255];
    s.fillRect(0, y, W, 1, c);
  }
  const cell = 34;                        // 16*34 = 544px art
  const art = grid * cell;
  const ox = Math.floor((W - art) / 2), oy = Math.floor((H - art) / 2);
  // a soft plate behind the art so transparent drawings still read
  s.fillRect(ox - 14, oy - 14, art + 28, art + 28, hexRgb('#241b38'));
  const colors = palette.map(hexRgb);
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (!v || !colors[v]) continue;
    s.fillRect(ox + (i % grid) * cell, oy + Math.floor(i / grid) * cell, cell, cell, colors[v]);
  }
  // brand bar: a small purple diamond bottom-center
  const d = hexRgb('#9966ff');
  const bx = Math.floor(W / 2), by = H - 26;
  [[0, -8], [-4, -4], [4, -4], [-8, 0], [8, 0], [0, 8], [-4, 4], [4, 4], [0, -4], [-4, 0], [4, 0], [0, 4], [0, 0]]
    .forEach(([dx, dy]) => s.fillRect(bx + dx - 2, by + dy - 2, 4, 4, d));
  return s.png();
}

module.exports = { encodePng, surface, hexRgb, nftCardPng };
