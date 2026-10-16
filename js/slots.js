// Deteksi lubang foto otomatis dari alpha channel (untuk frame tanpa koordinat "slots").

export function detectSlots(img, frameW = 600, frameH = 1800) {
  const iw = img.naturalWidth || frameW, ih = img.naturalHeight || frameH;
  const s = 500 / Math.max(iw, ih);
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const total = w * h, hole = new Uint8Array(total), seen = new Uint8Array(total);
  for (let i = 0; i < total; i++) hole[i] = px[i * 4 + 3] < 230 ? 1 : 0;

  const comps = [];
  for (let start = 0; start < total; start++) {
    if (!hole[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let area = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && hole[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && hole[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && hole[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && hole[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (area >= total * 0.01 && area <= total * 0.6) comps.push({ minX, minY, maxX, maxY });
  }
  comps.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  const k = frameW / iw;   // skala balik ke koordinat frame
  return comps.map(c => ({
    x: Math.floor(c.minX / s * k), y: Math.floor(c.minY / s * k),
    w: Math.ceil((c.maxX - c.minX + 1) / s * k), h: Math.ceil((c.maxY - c.minY + 1) / s * k),
  }));
}
