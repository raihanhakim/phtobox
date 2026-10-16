// Menyusun strip: putih -> foto (bleed 4%) -> frame -> caption -> footer.

export const FRAME_W = 600, FRAME_H = 1800;
export const BLEED = 0.04;
export const UI_FONT = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const FOOTER_Y1 = 1724, FOOTER_Y2 = 1760;

export const FILTERS = [
  ['normal', 'Normal'], ['bw', 'Hitam-Putih'], ['vintage', 'Vintage'], ['warm', 'Hangat'], ['analog', 'Analog'],
];
// Pendekatan CSS untuk video live (hasil akhir memakai piksel, bukan ctx.filter).
export const FILTER_CSS = {
  normal: 'none',
  bw: 'grayscale(1) contrast(1.1)',
  vintage: 'sepia(.45) contrast(.95) saturate(1.2) brightness(1.03)',
  warm: 'sepia(.2) saturate(1.2) hue-rotate(-10deg) brightness(1.02)',
  analog: 'sepia(.2) saturate(.85) contrast(.95) brightness(1.05)',
};

export async function ensureFonts(frame, captionText) {
  try {
    const jobs = ['700 30px "IBM Plex Mono"', '500 22px "IBM Plex Mono"'].map(s => document.fonts.load(s));
    if (frame && frame.caption) jobs.push(document.fonts.load(`${frame.caption.size}px "${frame.caption.font}"`, captionText || 'a'));
    await Promise.all(jobs);
    await document.fonts.ready;
  } catch (e) { /* pakai font cadangan */ }
}

/* ---------- filter piksel (dengan cache per foto) ---------- */
const cache = new WeakMap();

function filterPixels(src, type) {
  const w = src.width, h = src.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const cx = w / 2, cy = h / 2, maxD = cx * cx + cy * cy;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (type === 'bw') {
      r = g = b = (0.299 * r + 0.587 * g + 0.114 * b - 128) * 1.1 + 128;
    } else if (type === 'vintage') {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = (r * 0.45 + sr * 0.55) * 0.92 + 20; g = (g * 0.45 + sg * 0.55) * 0.92 + 16; b = (b * 0.45 + sb * 0.55) * 0.92 + 14;
    } else if (type === 'warm') {
      r = r * 1.08 + 8; g = g * 1.02 + 2; b = b * 0.88;
    } else if (type === 'analog') {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const sh = (1 - lum) * (1 - lum), hi = lum * lum;
      r = r * 0.9 + 20 - sh * 8 + hi * 14;           // warna pudar
      g = g * 0.9 + 20 + sh * 10 + hi * 4;           // shadow kehijauan
      b = b * 0.9 + 20 + sh * 2 - hi * 12;           // highlight hangat
      const x = (p % w) - cx, y = ((p / w) | 0) - cy;
      const v = 1 - 0.22 * ((x * x + y * y) / maxD); // vignette tipis
      const n = (Math.random() - 0.5) * 24;          // grain ±12
      r = r * v + n; g = g * v + n; b = b * v + n;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function filtered(src, type) {
  if (!src || type === 'normal') return src;
  let m = cache.get(src);
  if (!m) { m = new Map(); cache.set(src, m); }
  if (!m.has(type)) m.set(type, filterPixels(src, type));
  return m.get(type);
}

/* ---------- layout slot ---------- */
/** Bagian-bagian di dalam satu slot (koordinat lokal W x H). who: 'a' = host/solo, 'b' = tamu. */
export function slotParts(layout, W, H, swap = false) {
  const [l, r] = swap ? ['b', 'a'] : ['a', 'b'];
  if (layout === 'lr') return [{ who: l, x: 0, y: 0, w: W / 2, h: H }, { who: r, x: W / 2, y: 0, w: W / 2, h: H }];
  if (layout === 'tb') return [{ who: l, x: 0, y: 0, w: W, h: H / 2 }, { who: r, x: 0, y: H / 2, w: W, h: H / 2 }];
  if (layout === 'pip') {
    const m = Math.min(W, H), rad = m * 0.16, inset = m * 0.14;
    return [{ who: l, x: 0, y: 0, w: W, h: H }, { who: r, circle: true, x: W - 2 * rad - inset, y: H - 2 * rad - inset, w: 2 * rad, h: 2 * rad }];
  }
  return [{ who: 'a', x: 0, y: 0, w: W, h: H }];
}

function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function heart(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx - s * 1.5, cy - s * 0.1, cx - s * 1.0, cy - s * 1.1, cx, cy - s * 0.4);
  ctx.bezierCurveTo(cx + s * 1.0, cy - s * 1.1, cx + s * 1.5, cy - s * 0.1, cx, cy + s * 0.9);
  ctx.closePath();
}

/** Gambar isi satu slot ke kotak (x,y,w,h) di ctx. entry = {a, b} berisi canvas foto mentah. */
export function drawSlot(ctx, entry, x, y, w, h, { layout = 'solo', swap = false, filter = 'normal', s = 1 } = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#cfc8bb'; ctx.fillRect(x, y, w, h);
  const parts = slotParts(layout, w, h, swap);
  for (const p of parts) {
    const img = entry && entry[p.who];
    ctx.save();
    if (p.circle) {
      ctx.beginPath(); ctx.arc(x + p.x + p.w / 2, y + p.y + p.h / 2, p.w / 2, 0, Math.PI * 2); ctx.clip();
    } else { ctx.beginPath(); ctx.rect(x + p.x, y + p.y, p.w, p.h); ctx.clip(); }
    if (img) drawCover(ctx, filtered(img, filter), x + p.x, y + p.y, p.w, p.h);
    ctx.restore();
    if (p.circle) {
      ctx.lineWidth = 5 * s; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(x + p.x + p.w / 2, y + p.y + p.h / 2, p.w / 2, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (layout === 'lr' || layout === 'tb') {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * s;
    ctx.beginPath();
    if (layout === 'lr') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); } else { ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); }
    ctx.stroke();
    ctx.fillStyle = '#ff5fa2'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * s;
    heart(ctx, x + w / 2, y + h / 2, 11 * s); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

export function slotRect(slot, S = 1) {
  const bx = slot.w * BLEED, by = slot.h * BLEED;
  return { x: (slot.x - bx) * S, y: (slot.y - by) * S, w: (slot.w + 2 * bx) * S, h: (slot.h + 2 * by) * S };
}

function fitText(ctx, text, fontFn, size, maxW, min = 12) {
  let sz = size;
  ctx.font = fontFn(sz);
  while (ctx.measureText(text).width > maxW && sz > min) { sz -= 1; ctx.font = fontFn(sz); }
  return sz;
}

/**
 * opts: { frame, photos:[{a,b}], layout, swap, filter, caption, footer:{line1,line2}|null, scale }
 * Mengembalikan canvas 1200x3600 (scale 2).
 */
export async function renderStrip(opts, target) {
  const { frame, photos = [], layout = 'solo', swap = false, filter = 'normal', caption, footer, mark, scale: S = 2 } = opts;
  await ensureFonts(frame, caption);
  const c = target || document.createElement('canvas');
  c.width = FRAME_W * S; c.height = FRAME_H * S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  frame.slots.forEach((slot, i) => {
    const r = slotRect(slot, S);
    drawSlot(ctx, photos[i], r.x, r.y, r.w, r.h, { layout, swap, filter, s: S });
  });
  ctx.drawImage(frame.img, 0, 0, c.width, c.height);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cap = frame.caption, text = caption != null ? caption : cap.text;
  if (text) {
    ctx.save();
    ctx.translate(cap.x * S, cap.y * S); ctx.rotate((cap.rotate || 0) * Math.PI / 180);
    ctx.fillStyle = cap.color;
    fitText(ctx, text, sz => `${sz * S}px "${cap.font}", sans-serif`, cap.size, 540 * S, 14);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  if (footer) {
    ctx.fillStyle = frame.footerColor || '#222';
    let sz = 28;
    const f1 = z => `700 ${z * S}px ${UI_FONT}`, f2 = z => `500 ${z * S}px ${UI_FONT}`;
    ctx.font = f1(sz);
    while (ctx.measureText(footer.line1).width > 540 * S && sz > 12) { sz -= 1; ctx.font = f1(sz); }
    ctx.fillText(footer.line1, c.width / 2, FOOTER_Y1 * S);
    sz = 21; ctx.font = f2(sz);
    while (ctx.measureText(footer.line2).width > 540 * S && sz > 10) { sz -= 1; ctx.font = f2(sz); }
    ctx.globalAlpha = 0.9;
    ctx.fillText(footer.line2, c.width / 2, FOOTER_Y2 * S);
    ctx.globalAlpha = 1;
  }
  if (mark) {
    ctx.fillStyle = frame.footerColor || '#222';
    ctx.globalAlpha = 0.85;
    ctx.font = `500 ${15 * S}px ${UI_FONT}`;
    ctx.fillText(mark, c.width / 2, 1787 * S);
    ctx.globalAlpha = 1;
  }
  return c;
}
