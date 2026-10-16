// Efek suara lewat Web Audio API (tanpa berkas audio).

let ctx = null;
let enabled = true;

export function setSound(on) { enabled = on; if (on) unlock(); }
export function isSound() { return enabled; }

export function unlock() {
  if (!enabled) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { ctx = null; }
}

function env(g, t, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

export function tick() {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 1000;
  env(g, t, 0.3, 0.09);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.1);
}

export function shutter() {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime, len = Math.floor(ctx.sampleRate * 0.18);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const n = ctx.createBufferSource(); n.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2800; f.Q.value = 0.8;
  const g = ctx.createGain(); env(g, t, 0.5, 0.16);
  n.connect(f).connect(g).connect(ctx.destination); n.start(t);
  const o = ctx.createOscillator(), g2 = ctx.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.05);
  env(g2, t, 0.25, 0.06);
  o.connect(g2).connect(ctx.destination); o.start(t); o.stop(t + 0.08);
}
