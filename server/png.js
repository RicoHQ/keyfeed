// Social preview images without dependencies: a tiny RGB canvas, a 5×7 bitmap font and a PNG
// encoder (zlib via CompressionStream, available on Node 18+ and Cloudflare Workers).

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '%': ['11000', '11001', '00010', '00100', '01000', '10011', '00011'],
  '/': ['00000', '00001', '00010', '00100', '01000', '10000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '~': ['00000', '00000', '01000', '10101', '00010', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '[': ['01110', '01000', '01000', '01000', '01000', '01000', '01110'],
  ']': ['01110', '00010', '00010', '00010', '00010', '00010', '01110'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  '*': ['00000', '00100', '10101', '01110', '10101', '00100', '00000'],
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export class Canvas {
  constructor(w, h, bg = '#0d1116') {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  set(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) { this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; return; }
    this.px[i] = this.px[i] * (1 - a) + r * a; this.px[i + 1] = this.px[i + 1] * (1 - a) + g * a; this.px[i + 2] = this.px[i + 2] * (1 - a) + b * a;
  }
  rect(x, y, w, h, color, alpha = 1, radius = 0) {
    const c = typeof color === 'string' ? hex(color) : color;
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
        if (radius) {
          const dx = Math.max(x + radius - xx, xx - (x + w - 1 - radius), 0);
          const dy = Math.max(y + radius - yy, yy - (y + h - 1 - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        this.set(xx, yy, c, alpha);
      }
    }
  }
  /** Vertical gradient fill between two colours. */
  gradient(x, y, w, h, top, bottom, alpha = 1) {
    const a = hex(top), b = hex(bottom);
    for (let yy = 0; yy < h; yy++) {
      const t = yy / Math.max(1, h - 1);
      this.rect(x, y + yy, w, 1, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], alpha);
    }
  }
  textWidth(text, scale) { return String(text).length * 6 * scale - scale; }
  text(text, x, y, scale, color, maxWidth = Infinity) {
    let s = String(text).toUpperCase().replace(/[·•|]/g, '-').replace(/[^A-Z0-9 .,:#+\-%/!?_~()[\]'&>*]/g, '?');
    while (s.length > 1 && this.textWidth(s, scale) > maxWidth) s = s.slice(0, -2) + '…';
    s = s.replace('…', '.');
    const c = hex(color);
    let cx = x;
    for (const ch of s) {
      const g = FONT[ch] || FONT['?'];
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
        if (g[row][col] === '1') this.rect(cx + col * scale, y + row * scale, scale, scale, c);
      }
      cx += 6 * scale;
    }
    return cx;
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function encodePNG(canvas) {
  const { w, h, px } = canvas;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const ACCENT = '#4cc9f0';

/** 1200×630 share card. lines: [{ text, scale, color }], stats: [{ label, value }] */
export async function renderCard({ title, subtitle, stats = [], tag = 'OSU!MANIA TRACKER', hue }) {
  const c = new Canvas(1200, 630);
  c.gradient(0, 0, 1200, 630, '#121a24', '#0b0f14');
  c.rect(0, 0, 14, 630, ACCENT);
  // logo bars
  const bars = [[0, 40, 0.45], [22, 22, 0.7], [44, 0, 1], [66, 30, 0.55]];
  for (const [x, top, a] of bars) c.rect(70 + x, 60 + top, 14, 70 - top, ACCENT, a, 6);
  c.text('KEYFEED', 170, 76, 6, '#e7edf3');
  c.text(tag, 172, 128, 3, '#8b9aab');
  if (hue != null) c.rect(1040, 60, 90, 90, `#${hslHex(hue)}`, 1, 18);

  c.text(title, 70, 220, 11, '#ffffff', 1060);
  if (subtitle) c.text(subtitle, 74, 318, 4, '#8b9aab', 1060);

  const n = Math.min(4, stats.length);
  const boxW = n ? Math.floor((1060 - (n - 1) * 20) / n) : 0;
  stats.slice(0, 4).forEach((s, i) => {
    const x = 70 + i * (boxW + 20);
    c.rect(x, 400, boxW, 160, '#1a2330', 1, 18);
    c.text(s.label, x + 24, 428, 3, '#8b9aab', boxW - 48);
    let scale = 7;
    while (scale > 3 && c.textWidth(s.value, scale) > boxW - 48) scale--;
    c.text(s.value, x + 24, 478 + (7 - scale) * 4, scale, i === 0 ? ACCENT : '#e7edf3', boxW - 48);
  });
  return encodePNG(c);
}

function hslHex(h) {
  const f = (n) => { const k = (n + h / 30) % 12; const a = 0.55 * Math.min(0.42, 1 - 0.42); return Math.round(255 * (0.42 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return f(0) + f(8) + f(4);
}
