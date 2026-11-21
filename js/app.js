import { detectSlots } from './slots.js';
import { openCamera, stopStream, captureRaw, checkSupport } from './camera.js';
import { renderStrip, drawSlot, slotRect, partBoxes, FILTERS, FILTER_CSS, FRAME_W, FRAME_H } from './compose.js';
import { Room, normalizeCode } from './ldr.js';
import * as sfx from './audio.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const GAP_MS = 1500;
const LS = { name: 'karebooth:name', city: 'karebooth:city', booth: 'karebooth:booth', serial: 'karebooth:serial', theme: 'karebooth:theme' };

const S = {
  mode: null, role: 'host', frames: [], screen: 'home',
  cfg: { frameId: null, layout: 'solo', swap: false, filter: 'normal', timer: 3, caption: null, footer: true },
  photos: [], stream: null, camToken: 0, camReady: false, remoteStream: null,
  room: null, me: { name: '', city: '', tz: '' }, partner: null, connStatus: 'connecting',
  ready: { me: false, partner: false },
  running: false, token: 0, retake: null, current: -1, sending: 0, takenAt: null, serial: null,
  blob: null, url: null, mime: 'image/png', renderToken: 0, slotEls: [], lobbyTab: 'create',
};
const el = {
  cam: $('#cam'), remote: $('#remote'), strip: $('#live-strip'), start: $('#btn-start'), ready: $('#btn-ready'),
  canvas: $('#result-canvas'), hits: $('#result-hits'), countdown: $('#countdown'), flash: $('#flash'),
};

/* ===================== util ===================== */
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ } };
const frame = () => S.frames.find(f => f.id === S.cfg.frameId);
const isLdr = () => S.mode === 'ldr';
const isHost = () => S.role === 'host';
const mineKey = () => (isLdr() && S.role === 'guest') ? 'b' : 'a';
const otherKey = () => mineKey() === 'a' ? 'b' : 'a';
const captionText = () => S.cfg.caption != null ? S.cfg.caption : (frame() ? frame().caption.text : '');
const pct = (v, t) => (v / t * 100).toFixed(3) + '%';
const hostName = () => isHost() ? S.me.name : (S.partner && S.partner.name) || 'host';
const lbl = (sel, text) => { const e = $(sel + ' .lbl'); if (e) e.textContent = text; };
const setIcon = (sel, name) => { const u = $(sel + ' use'); if (u) u.setAttribute('href', '#i-' + name); };

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('gagal memuat ' + src)); i.src = src; });
}
function setBanner(msg, kind = '') {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg; b.className = 'banner ' + kind; b.hidden = false;
}

/** pindahkan data lama (skenabooth / photobooth) ke key karebooth, lalu hapus key lama */
function migrateStorage() {
  try {
    const map = { 'sb:name': LS.name, 'sb:city': LS.city, 'sb:booth': LS.booth, 'photobooth:name': LS.booth };
    for (const [oldKey, newKey] of Object.entries(map)) {
      const v = localStorage.getItem(oldKey);
      if (v === null) continue;
      if (!localStorage.getItem(newKey)) localStorage.setItem(newKey, v);
      localStorage.removeItem(oldKey);
    }
  } catch (e) { /* abaikan */ }
}

/* rotasi kecil dengan seed tetap per elemen */
function seedRot(key, range = 2) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const v = ((h >>> 0) % 10000) / 10000;
  const deg = (v * 2 - 1) * range;
  return (Math.abs(deg) < 0.5 ? (deg < 0 ? -0.8 : 0.8) : deg).toFixed(2) + 'deg';
}
function applyTilt(root = document) {
  $$('[data-tilt]', root).forEach(e => e.style.setProperty('--rot', seedRot(e.dataset.tilt)));
}

/* ===================== coretan rough.js (maks 3-4 per layar) ===================== */
const NS = 'http://www.w3.org/2000/svg';
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#e8412c';
function addScribble(host, pad, fn) {
  if (!window.rough || !host) return;
  const r = host.getBoundingClientRect();
  if (!r.width) return;
  const w = r.width + pad * 2, h = r.height + pad * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'scribble'); svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.style.left = -pad + 'px'; svg.style.top = -pad + 'px';
  host.appendChild(svg);
  fn(window.rough.svg(svg), svg, w, h);
}
function drawScribbles() {
  $$('.scribble').forEach(s => s.remove());
  if (!window.rough) return;
  const stroke = cssVar('--merah');
  const o = (seed, sw = 2.4) => ({ stroke, strokeWidth: sw, roughness: 1.5, bowing: 1.2, seed, fill: 'none' });
  // 1. garis bawah wordmark
  addScribble($('#logo'), 6, (rc, svg, w, h) => {
    svg.appendChild(rc.line(4, h - 3, w - 6, h - 7, o(3, 2.6)));
    svg.appendChild(rc.line(12, h - 1, w - 18, h - 3, o(5, 1.8)));
  });
  // 2. langkah aktif dilingkari
  if (!$('#steps').hidden) {
    addScribble($('#steps li.active'), 7, (rc, svg, w, h) => svg.appendChild(rc.ellipse(w / 2, h / 2, w - 2, h - 2, o(11, 2.2))));
  }
  // 3. panah catatan ke kartu ldr
  if (S.screen === 'home' && window.innerWidth > 860) {
    const host = $('.home-right'), note = $('#home-note'), card = $('#btn-mode-ldr');
    if (host && note && card) {
      const hr = host.getBoundingClientRect(), nr = note.getBoundingClientRect(), cr = card.getBoundingClientRect();
      const x1 = nr.left - hr.left + nr.width * .8, y1 = nr.top - hr.top - 2;
      const x2 = cr.left - hr.left + cr.width * .3, y2 = cr.bottom - hr.top + 8;
      addScribble(host, 0, (rc, svg) => {
        svg.appendChild(rc.curve([[x1, y1], [(x1 + x2) / 2 + 14, (y1 + y2) / 2 + 8], [x2, y2]], o(21, 2.2)));
        svg.appendChild(rc.line(x2, y2, x2 - 9, y2 + 12, o(22, 2.2)));
        svg.appendChild(rc.line(x2, y2, x2 + 12, y2 + 9, o(23, 2.2)));
      });
    }
  }
}
let scribbleTimer = null;
const scheduleScribbles = () => { clearTimeout(scribbleTimer); scribbleTimer = setTimeout(drawScribbles, 60); };

/* ===================== layar ===================== */
const SCREENS = ['home', 'frames', 'lobby', 'booth', 'result'];
function show(name) {
  S.screen = name;
  SCREENS.forEach(s => { $('#screen-' + s).hidden = s !== name; });
  const stepNo = { frames: 1, lobby: 1, booth: 2, result: 3 }[name];
  $('#steps').hidden = !stepNo;
  $$('#steps li').forEach(li => li.classList.toggle('active', +li.dataset.step === stepNo));
  $('#step1-label').textContent = isLdr() ? 'room' : 'pilih frame';
  document.body.dataset.mode = S.mode || '';
  document.body.dataset.role = S.role;
  window.scrollTo(0, 0);
  scheduleScribbles();
}

/* ===================== frame ===================== */
async function loadFrames() {
  $('#frame-error').hidden = true;
  try {
    if (location.protocol === 'file:') throw new Error('file');
    const res = await fetch('frames/frames.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    await Promise.all(data.frames.map(async f => {
      f.url = 'frames/' + f.file;
      f.img = await loadImage(f.url);
      if (!f.slots || !f.slots.length) f.slots = detectSlots(f.img, FRAME_W, FRAME_H);
      if (!f.slots.length) throw new Error('lubang foto nggak ketemu di ' + f.file);
      if (!f.caption) f.caption = { text: '', font: 'IBM Plex Mono', size: 40, color: '#222', x: 300, y: 1668, rotate: 0 };
    }));
    S.frames = data.frames;
    renderRail(); renderPicker();
    return true;
  } catch (e) {
    console.error(e);
    $('#frame-error-msg').textContent = location.protocol === 'file:'
      ? 'framenya nggak bisa dimuat karena halaman dibuka lewat file://. jalankan lewat server lokal (npx serve .) lalu buka http://localhost.'
      : 'frames.json gagal dimuat. cek koneksimu atau berkas frames/frames.json, lalu coba lagi.';
    $('#frame-error').hidden = false;
    return false;
  }
}

function renderRail() {
  const rail = $('#frame-rail'); rail.innerHTML = '';
  for (const f of S.frames) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hang'; b.dataset.id = f.id;
    b.setAttribute('aria-label', 'jepit frame ' + f.name);
    b.innerHTML = '<svg class="rope" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M0,8 Q50,26 100,8"/></svg>'
      + '<span class="pin" aria-hidden="true"><svg viewBox="0 0 24 48"><use href="#i-pin"/></svg></span>'
      + '<span class="sw"><span class="thumb"><img alt=""><span class="nums"></span></span></span>'
      + '<span class="tag"><b></b></span><span class="cap"></span>';
    $('img', b).src = f.url;
    $('.tag b', b).textContent = f.name; $('.cap', b).textContent = '“' + f.caption.text + '”';
    $('.sw', b).style.setProperty('--rot', seedRot(f.id));
    $('.tag', b).style.setProperty('--rot2', seedRot(f.id + 'tag', 3));
    f.slots.forEach((s, i) => {
      const n = document.createElement('i'); n.textContent = i + 1;
      n.style.left = pct(s.x + s.w / 2, FRAME_W); n.style.top = pct(s.y + s.h / 2, FRAME_H);
      $('.nums', b).appendChild(n);
    });
    b.addEventListener('click', () => {
      setFrame(f.id); S.photos = []; S.retake = null; markSelected();
      setTimeout(enterBooth, 160);
    });
    rail.appendChild(b);
  }
  markSelected();
}
function markSelected() { $$('.hang').forEach(h => h.classList.toggle('sel', h.dataset.id === S.cfg.frameId)); }

function renderPicker() {
  const p = $('#frame-picker'); p.innerHTML = '';
  for (const f of S.frames) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = f.id; b.title = f.name; b.setAttribute('aria-label', f.name);
    b.innerHTML = '<img alt="">'; $('img', b).src = f.url;
    b.addEventListener('click', () => { setFrame(f.id); pushCfg(); afterCfgChange(); });
    p.appendChild(b);
  }
}
function setFrame(id) {
  const f = S.frames.find(x => x.id === id);
  if (!f) return;
  S.cfg.frameId = id; S.cfg.caption = null;
  if (f.defaultFilter) S.cfg.filter = f.defaultFilter;
}

/* ===================== nomor seri ===================== */
const nextSerial = () => (parseInt(lsGet(LS.serial) || '0', 10) || 0) + 1;
const serialStr = n => 'no. ' + String(n).padStart(4, '0');
const markText = () => 'karebooth' + (S.serial ? ' · ' + serialStr(S.serial) : '');

/* ===================== kontrol & konfigurasi ===================== */
function buildFilterChips() {
  for (const box of [$('#filter-chips'), $('#result-filter-chips')]) {
    box.innerHTML = '';
    for (const [id, label] of FILTERS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.filter = id; b.textContent = label.toLowerCase();
      b.addEventListener('click', () => { S.cfg.filter = id; pushCfg(); afterCfgChange(); });
      box.appendChild(b);
    }
  }
}

function syncControls() {
  $$('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === S.cfg.filter));
  $$('[data-timer]').forEach(b => b.classList.toggle('active', +b.dataset.timer === S.cfg.timer));
  $$('[data-layout]').forEach(b => b.classList.toggle('active', b.dataset.layout === S.cfg.layout));
  $$('#frame-picker button').forEach(b => b.classList.toggle('active', b.dataset.id === S.cfg.frameId));
  for (const i of [$('#in-caption'), $('#in-caption-result')]) if (document.activeElement !== i) i.value = captionText();
  const ft = $('#btn-footer');
  ft.setAttribute('aria-pressed', S.cfg.footer); ft.textContent = S.cfg.footer ? 'footer: nyala' : 'footer: mati';
  if (isLdr()) $('#owner-note').textContent = isHost() ? `pilihanmu otomatis dilihat ${S.partner ? S.partner.name : 'dia'}.` : `diatur sama ${hostName()}`;
  const fp = $('#frame-picker .active'); if (fp && fp.scrollIntoView) { try { fp.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* abaikan */ } }
}

function afterCfgChange() {
  syncControls();
  if (S.screen === 'booth') buildLive();
  if (S.screen === 'result') scheduleRender();
}
function pushCfg() { if (isLdr() && isHost() && S.room) S.room.send({ type: 'cfg', cfg: S.cfg, serial: S.serial }); }

/* ===================== footer ===================== */
const ID_TZ = { 'Asia/Jakarta': 'WIB', 'Asia/Pontianak': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT' };
function tzLabel(tz, d) {
  if (ID_TZ[tz]) return ID_TZ[tz];
  try {
    const p = new Intl.DateTimeFormat('id-ID', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName');
    if (p) return p.value;
  } catch (e) { /* abaikan */ }
  return 'UTC';
}
function timeIn(tz, d) {
  try { return new Intl.DateTimeFormat('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d); }
  catch (e) { return `${pad(d.getHours())}.${pad(d.getMinutes())}`; }
}
function dateIn(tz, d, style) {
  try { return new Intl.DateTimeFormat('id-ID', { timeZone: tz, day: 'numeric', month: style, year: 'numeric' }).format(d); }
  catch (e) { return d.toDateString(); }
}
function footerInfo() {
  const d = new Date(S.takenAt || Date.now());
  if (!isLdr()) {
    const name = ($('#in-booth').value.trim() || 'photobooth');
    return { line1: name, line2: dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone, d, 'long') };
  }
  if (!S.cfg.footer) return null;
  const host = isHost() ? S.me : (S.partner || { name: 'host', city: '', tz: S.me.tz });
  const guest = isHost() ? (S.partner || { name: 'dia', city: '', tz: S.me.tz }) : S.me;
  const [l, r] = S.cfg.swap ? [guest, host] : [host, guest];
  const nm = p => p.city ? `${p.name} · ${p.city}` : p.name;
  const tl = timeIn(l.tz, d), tr = timeIn(r.tz, d), ll = tzLabel(l.tz, d), lr = tzLabel(r.tz, d);
  const time = (tl === tr && ll === lr) ? `${tl} ${ll}` : `${tl} ${ll} / ${tr} ${lr}`;
  return { line1: `${nm(l)} ♡ ${nm(r)}`, line2: `${dateIn(host.tz, d, 'short')} · ${time}` };
}

/* ===================== strip live ===================== */
function hasPhoto(i) {
  const e = S.photos[i];
  if (!e) return false;
  return isLdr() ? !!(e.a && e.b) : !!e.a;
}
function activeSlot() {
  if (S.current >= 0) return S.current;
  if (S.running) return -1;
  if (S.retake != null) return S.retake;
  const f = frame(); if (!f) return -1;
  for (let i = 0; i < f.slots.length; i++) if (!hasPhoto(i)) return i;
  return -1;
}

function buildLive() {
  const f = frame(); if (!f) return;
  const st = el.strip; st.innerHTML = '';
  S.slotEls = f.slots.map((s, i) => {
    const r = slotRect(s, 1), d = document.createElement('div');
    d.className = 'slot'; d.dataset.n = i + 1;
    d.style.left = pct(r.x, FRAME_W); d.style.top = pct(r.y, FRAME_H); d.style.width = pct(r.w, FRAME_W); d.style.height = pct(r.h, FRAME_H);
    st.appendChild(d); return d;
  });
  const ov = document.createElement('img'); ov.className = 'overlay'; ov.alt = ''; ov.src = f.url; st.appendChild(ov);
  const c = f.caption, cap = document.createElement('div');
  cap.className = 'txt cap'; cap.textContent = captionText();
  Object.assign(cap.style, { top: pct(c.y, FRAME_H), color: c.color, fontFamily: `"${c.font}", sans-serif`, fontSize: `calc(${c.size} / 600 * 100cqw)`, transform: `translateY(-50%) rotate(${c.rotate || 0}deg)` });
  st.appendChild(cap);
  const ft = footerInfo(), items = [];
  if (ft) items.push(['f1', ft.line1, 1724], ['f2', ft.line2, 1760]);
  items.push(['mark', markText(), 1787]);
  for (const [cls, text, y] of items) {
    const t = document.createElement('div'); t.className = 'txt ' + cls; t.textContent = text;
    t.style.top = pct(y, FRAME_H); t.style.color = f.footerColor; st.appendChild(t);
  }
  refreshLive();
}

function refreshLive() {
  const f = frame(); if (!f) return;
  const active = activeSlot(), css = FILTER_CSS[S.cfg.filter];
  S.slotEls.forEach((d, i) => {
    d.innerHTML = ''; d.classList.toggle('active', i === active);
    const slot = f.slots[i], r = slotRect(slot, 1);
    if (i === active) {
      // geometri bagian + pita sambungan dari compose.js: pratinjau live dan hasil
      // render memakai hitungan yang sama, jadi sambungannya nggak bisa melenceng
      for (const p of partBoxes(S.cfg.layout, r.w, r.h, S.cfg.swap)) {
        const pd = document.createElement('div');
        pd.className = 'part' + (p.circle ? ' circle' : '') + (p.seam ? ' seam seam-' + S.cfg.layout : '');
        Object.assign(pd.style, { left: pct(p.x, r.w), top: pct(p.y, r.h), width: pct(p.w, r.w), height: pct(p.h, r.h) });
        if (p.seam) pd.style.setProperty('--seam', p.seamPct.toFixed(3) + '%');
        const stream = p.who === mineKey() ? S.stream : S.remoteStream;
        if (stream) {
          const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true;
          v.style.filter = css; v.srcObject = stream; pd.appendChild(v); v.play().catch(() => {});
        }
        d.appendChild(pd);
      }
    } else if (S.photos[i] && (S.photos[i].a || S.photos[i].b)) {
      const c = document.createElement('canvas'); c.width = Math.round(r.w); c.height = Math.round(r.h);
      drawSlot(c.getContext('2d'), S.photos[i], 0, 0, c.width, c.height, { layout: S.cfg.layout, swap: S.cfg.swap, filter: S.cfg.filter, s: 1 });
      d.appendChild(c);
    }
    d.classList.toggle('filled', d.childElementCount > 0);
  });
}

/* ===================== kamera ===================== */
function bindLocal(stream) {
  S.stream = stream; el.cam.srcObject = stream; el.cam.style.filter = FILTER_CSS[S.cfg.filter];
  S.camReady = false;
  const ok = () => { S.camReady = true; $('#cam-status').classList.add('off'); updateButtons(); refreshLive(); };
  el.cam.onloadedmetadata = () => { el.cam.play().catch(() => {}); };
  el.cam.onplaying = ok;
  el.cam.play().then(() => { if (el.cam.videoWidth) ok(); }).catch(() => {});
}

async function startSoloCamera() {
  stopSoloCamera();
  const tk = ++S.camToken;
  $('#cam-error').hidden = true; $('#cam-status').classList.remove('off'); $('#cam-status').textContent = 'nyalain kamera…';
  S.camReady = false; updateButtons();
  try {
    const stream = await openCamera({ audio: false });
    if (tk !== S.camToken) { stopStream(stream); return; }
    bindLocal(stream);
  } catch (e) {
    if (tk !== S.camToken) return;
    console.warn(e);
    $('#cam-status').classList.add('off');
    $('#cam-error-msg').textContent = e.userMessage || 'kameranya nggak bisa nyala.';
    $('#cam-error').hidden = false;
  }
}
function stopSoloCamera() {
  S.camToken++;
  if (!isLdr()) { stopStream(S.stream); S.stream = null; el.cam.srcObject = null; S.camReady = false; }
}

/* ===================== alur: masuk booth / hasil ===================== */
function enterBooth() {
  cancelRun(false);
  S.current = -1; S.ready = { me: false, partner: false };
  if (S.retake == null && isHost()) S.serial = nextSerial();
  show('booth');
  $('#remote-label').textContent = S.partner ? `${S.partner.name} · ${S.partner.city}` : 'dia';
  $('#btn-back').textContent = isLdr() ? '← keluar' : (S.retake != null ? '← balik ke hasil' : '← ganti frame');
  if (isLdr()) {
    el.cam.srcObject = S.stream; S.camReady = !!(S.stream && el.cam.videoWidth);
    if (S.stream) bindLocal(S.stream);
    attachRemote();
  } else startSoloCamera();
  syncControls(); buildLive(); updateButtons(); updateReady();
}

function attachRemote() {
  if (S.remoteStream) { el.remote.srcObject = S.remoteStream; el.remote.play().catch(() => {}); $('#remote-wait').classList.add('off'); }
  else $('#remote-wait').classList.remove('off');
}

async function goResult() {
  cancelRun(false);
  stopSoloCamera();
  S.current = -1; S.retake = null;
  show('result'); syncControls();
  const rs = $('#result-strip'); rs.classList.remove('exit'); void rs.offsetWidth; rs.classList.add('exit');
  $('#result-hint').textContent = isLdr() ? (isHost() ? 'ketuk satu foto buat diulang bareng-bareng.' : 'host bisa ngetuk foto buat diulang bareng-bareng.') : 'ketuk satu foto buat diulang.';
  buildHits();
  $('#btn-share').hidden = !canShareFiles();
  await render();
}

function buildHits() {
  const f = frame(); el.hits.innerHTML = '';
  f.slots.forEach((s, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `ulangi foto ${i + 1}`);
    Object.assign(b.style, { left: pct(s.x, FRAME_W), top: pct(s.y, FRAME_H), width: pct(s.w, FRAME_W), height: pct(s.h, FRAME_H) });
    b.addEventListener('click', () => {
      if (isLdr() && !isHost()) return;
      S.retake = i;
      if (isLdr()) S.room.send({ type: 'nav', to: 'booth', retake: i });
      enterBooth();
    });
    el.hits.appendChild(b);
  });
}

/* ===================== render hasil ===================== */
let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 150); }
async function render() {
  const f = frame(); if (!f || !S.photos.some(Boolean)) return;
  const tk = ++S.renderToken;
  const c = await renderStrip({ frame: f, photos: S.photos, layout: S.cfg.layout, swap: S.cfg.swap, filter: S.cfg.filter, caption: captionText(), footer: footerInfo(), mark: markText(), scale: 2 }, el.canvas);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  if (tk !== S.renderToken) return;
  setBlob(blob);
}
function setBlob(blob, mime) {
  if (S.url) URL.revokeObjectURL(S.url);
  S.blob = blob; S.mime = mime || blob.type || 'image/png'; S.url = URL.createObjectURL(blob);
  $$('#print-sheet img').forEach(i => { i.src = S.url; });
}

const extOf = m => (m === 'image/jpeg' ? 'jpg' : 'png');
const fileName = () => { const d = new Date(); return `karebooth-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${extOf(S.mime)}`; };
function canShareFiles() {
  try {
    const type = S.mime || 'image/png';
    return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type })], 'a.' + extOf(type), { type })] }));
  } catch (e) { return false; }
}

/* ===================== sesi foto ===================== */
function showCount(n) {
  el.countdown.innerHTML = '';
  const s = document.createElement('span'); s.textContent = n;
  s.style.setProperty('--r', (Math.random() * 12 - 6).toFixed(1) + 'deg');
  el.countdown.appendChild(s);
}
function clearCount() { el.countdown.innerHTML = ''; }
function doFlash() { el.flash.classList.remove('go'); void el.flash.offsetWidth; el.flash.classList.add('go'); }

function countdownTo(atLocal, tk) {
  return new Promise(res => {
    let last = 0;
    if (isLdr()) el.countdown.innerHTML = '<span class="prep">siap-siap…</span>';
    const step = () => {
      if (tk !== S.token) { clearCount(); return res(false); }
      const rem = atLocal - Date.now();
      if (rem <= 0) { clearCount(); return res(true); }
      const n = Math.ceil(rem / 1000);
      if (n <= S.cfg.timer && n !== last) { last = n; showCount(n); sfx.tick(); }
      setTimeout(step, Math.min(30, rem));
    };
    step();
  });
}

function takeLocal(slot) {
  const raw = captureRaw(el.cam);
  doFlash(); sfx.shutter();
  S.photos[slot] = { ...(S.photos[slot] || {}), [mineKey()]: raw };
  return raw;
}

async function sendPhoto(slot, canvas) {
  if (!S.room || !canvas) return;
  // q0.85: ukuran turun ±27% dibanding q0.9 tapi bedanya nggak kelihatan di cetakan sekecil ini.
  // Resolusi sengaja nggak dikecilkan — layout atas-bawah butuh sumber selebar aslinya.
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  const buf = await blob.arrayBuffer();
  S.sending++; updateSending();
  S.room.send({ type: 'photo', slot, buf });
}
function updateSending() { $('#sending').hidden = S.sending <= 0; }

async function receivePhoto(m) {
  try {
    const bmp = await createImageBitmap(new Blob([m.buf], { type: 'image/jpeg' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    S.photos[m.slot] = { ...(S.photos[m.slot] || {}), [otherKey()]: c };
    S.room && S.room.send({ type: 'photoAck', slot: m.slot });
    if (S.screen === 'booth') refreshLive();
  } catch (e) { console.warn('foto pasangan gagal didecode', e); }
}

async function waitPartner(slot, tk, ms = 12000) {
  const t0 = Date.now();
  while (tk === S.token && Date.now() - t0 < ms) {
    if (S.photos[slot] && S.photos[slot][otherKey()]) return true;
    await sleep(80);
  }
  return false;
}

function setRunning(on) {
  S.running = on;
  document.body.classList.toggle('session-running', on);
  $('#session-label').hidden = !on;
  updateButtons();
}

function cancelRun(notify = true) {
  const was = S.running;
  S.token++; clearCount(); S.current = -1; S.sending = 0; updateSending();
  if (was) { setRunning(false); if (S.screen === 'booth') refreshLive(); }
  if (notify && was && isLdr() && S.room) S.room.send({ type: 'cancel' });
}

async function startSession() {
  if (S.running || !S.camReady) return;
  const f = frame(); sfx.unlock();
  const order = S.retake != null ? [S.retake] : f.slots.map((_, i) => i);
  if (isLdr() && !(S.ready.me && S.ready.partner && S.room && S.room.status !== 'lost')) return;
  const fresh = S.retake == null;
  if (fresh) S.photos = [];
  const tk = ++S.token;
  S.ready = { me: false, partner: false };
  setRunning(true); updateReady();
  if (!isLdr()) S.takenAt = Date.now();

  for (let k = 0; k < order.length; k++) {
    const slot = order[k];
    S.current = slot; S.photos[slot] = {};
    $('#session-label').textContent = `foto ${slot + 1} dari ${f.slots.length}`;
    refreshLive();
    let at;
    if (isLdr()) {
      at = S.room.hostNow() + 1000 + S.cfg.timer * 1000;
      if (k === 0) S.takenAt = at;
      S.room.send({ type: 'shoot', slot, at, first: k === 0, idx: k, total: order.length });
    } else at = Date.now() + S.cfg.timer * 1000;
    if (!(await countdownTo(at, tk))) return;
    const raw = takeLocal(slot);
    if (isLdr()) { sendPhoto(slot, raw); await waitPartner(slot, tk); if (tk !== S.token) return; }
    S.current = k + 1 < order.length ? order[k + 1] : -1;
    refreshLive();
    if (k + 1 < order.length) { await sleep(GAP_MS); if (tk !== S.token) return; }
  }
  await sleep(500);
  if (tk !== S.token) return;
  setRunning(false);
  if (fresh && S.serial) lsSet(LS.serial, String(S.serial));   // nomor seri bertambah tiap strip selesai
  if (isLdr()) S.room.send({ type: 'done', takenAt: S.takenAt, serial: S.serial });
  goResult();
}

async function guestShoot(m) {
  if (m.first) { S.ready = { me: false, partner: false }; if (S.retake == null) S.photos = []; }
  if (!S.running) { S.token++; setRunning(true); }
  const tk = S.token;
  updateReady();
  const slot = m.slot;
  S.current = slot; S.photos[slot] = {};
  if (m.first) S.takenAt = m.at;
  $('#session-label').textContent = `foto ${slot + 1} dari ${frame().slots.length}`;
  refreshLive();
  if (!(await countdownTo(S.room.toLocal(m.at), tk))) return;
  const raw = takeLocal(slot);
  sendPhoto(slot, raw);
  S.current = -1; refreshLive();
}

/* ===================== tombol & status ===================== */
function updateReady() {
  const r = $('#ready-line');
  if (!isLdr()) { r.textContent = ''; return; }
  const pn = S.partner ? S.partner.name : 'dia';
  r.textContent = `${S.me.name}: ${S.ready.me ? 'siap' : 'belum'}  ·  ${pn}: ${S.ready.partner ? 'siap' : 'belum'}`;
  updateButtons();
}

function updateButtons() {
  const f = frame();
  const retakeLabel = S.retake != null ? `jepret ulang no. ${S.retake + 1}` : 'jepret';
  el.start.textContent = S.running ? 'stop' : retakeLabel;
  el.start.classList.toggle('cancel', S.running);
  if (!isLdr()) {
    el.start.disabled = !S.running && !S.camReady;
  } else {
    const connected = S.room && S.room.status !== 'lost' && S.partner && S.connStatus !== 'lost';
    el.start.disabled = !S.running && !(connected && S.ready.me && S.ready.partner && S.camReady && f);
    lbl('#btn-ready', S.running ? 'batal' : (S.ready.me ? 'belum siap' : 'siap'));
    el.ready.classList.toggle('ready-on', S.ready.me && !S.running);
  }
}

function setConn(status) {
  S.connStatus = status;
  $('#conn-chip').className = 'conn ' + status;
  $('#conn-text').textContent = { connecting: 'lagi nyambung', connected: 'tersambung', weak: 'koneksi lemah', lost: 'terputus' }[status];
  updateButtons();
}

/* ===================== LDR: lobi ===================== */
function lobbyError(msg, retry) {
  $('#lobby-error-msg').textContent = msg; $('#lobby-error').hidden = false;
  $('#btn-lobby-retry').hidden = !retry; $('#lobby-loading').hidden = true; $('#lobby-form').hidden = false; $('#lobby-wait').hidden = true;
  $('#btn-lobby-go').disabled = false;
}
const ERR_TEXT = {
  server: 'server peerjs nggak bisa dihubungi. cek internetmu atau ganti jaringan, lalu coba lagi.',
  notfound: 'room-nya nggak ketemu atau udah ditutup host. cek lagi kodenya ya.',
  full: 'room-nya udah penuh. satu room cuma buat dua orang.',
  timeout: 'belum nyambung setelah 15 detik. coba ganti jaringan (misal dari data seluler ke wifi), atau minta host ngisi server turn di js/config.js.',
  closed: 'room-nya udah ditutup host.',
};

function setLobbyTab(tab) {
  S.lobbyTab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#field-code').hidden = tab !== 'join';
  $('#btn-lobby-go').textContent = tab === 'create' ? 'bikin room' : 'masuk';
  $('#in-code').required = tab === 'join';
}

function openLobby(code) {
  S.mode = 'ldr'; S.cfg.layout = 'lr'; S.cfg.footer = true;
  $('#in-name').value = lsGet(LS.name); $('#in-city').value = lsGet(LS.city);
  $('#lobby-error').hidden = true; $('#lobby-wait').hidden = true; $('#lobby-form').hidden = false; $('#lobby-loading').hidden = true;
  setLobbyTab(code ? 'join' : 'create');
  if (code) $('#in-code').value = code;
  show('lobby');
}

function roomHandlers() {
  return {
    onStatus: st => setConn(st),
    onRemoteStream: s => { S.remoteStream = s; attachRemote(); if (S.screen === 'booth') refreshLive(); },
    onMessage: onRoomMessage,
    onConnected: p => onPartnerConnected(p),
    onLost: p => {
      cancelRun(false);
      S.ready = { me: false, partner: false }; updateReady();
      setBanner(`yah, koneksi ${(p && p.name) || 'dia'} putus. tunggu bentar…`);
      $('#remote-wait').classList.remove('off');
    },
    onError: kind => {
      if (S.screen === 'lobby') return;
      setBanner(ERR_TEXT[kind] || 'ada masalah koneksi.', 'bad');
    },
  };
}

async function submitLobby(ev) {
  ev.preventDefault();
  const name = $('#in-name').value.trim(), city = $('#in-city').value.trim();
  if (!name || !city) return;
  const joining = S.lobbyTab === 'join';
  const code = normalizeCode($('#in-code').value);
  if (joining && code.length !== 6) return lobbyError('kode room harus 6 karakter.', false);
  lsSet(LS.name, name); lsSet(LS.city, city);
  S.me = { name, city, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
  S.role = joining ? 'guest' : 'host';
  document.body.dataset.role = S.role;
  $('#lobby-error').hidden = true; $('#btn-lobby-go').disabled = true;
  $('#lobby-loading').hidden = false; $('#lobby-loading').textContent = 'nyiapin kamera, mic, dan koneksi…';
  sfx.unlock();

  // Kamera dan pendaftaran ke server signaling dikerjakan barengan, bukan berurutan:
  // dua-duanya nunggu jaringan dan nggak saling butuh. Ini yang paling kerasa di data seluler.
  const room = new Room({ role: S.role, me: S.me, stream: S.stream, handlers: roomHandlers() });
  S.room = room;
  if (joining) room.preopen().catch(() => { /* nanti dicoba lagi di join() */ });

  let stream;
  try { stream = S.stream || await openCamera({ audio: true }); }
  catch (e) {
    try { room.close(); } catch (x) { /* abaikan */ }
    S.room = null;
    return lobbyError(e.userMessage || 'kamera/mic nggak bisa nyala.', true);
  }
  if (S.stream !== stream) bindLocal(stream);
  room.attachStream(stream);

  $('#lobby-loading').textContent = joining ? 'nyambung ke room…' : 'bikin room…';
  try {
    if (joining) await room.join(code);
    else {
      const c = await room.createRoom();
      $('#lobby-loading').hidden = true;
      showWait(c);
    }
  } catch (e) {
    try { room.close(); } catch (x) { /* abaikan */ }
    S.room = null;
    lobbyError(ERR_TEXT[e] || ERR_TEXT.server, true);
  }
}

function showWait(code) {
  $('#lobby-form').hidden = true; $('#lobby-wait').hidden = false;
  $('#room-code').textContent = code;
  const link = `${location.origin}${location.pathname}?room=${code}`;
  $('#invite-link').value = link;
  $('#btn-wa').href = 'https://wa.me/?text=' + encodeURIComponent(`yuk foto bareng di karebooth. masuk lewat link ini: ${link} (kode room: ${code})`);
  try {
    const q = window.qrcode(0, 'M'); q.addData(link); q.make();
    $('#qr').innerHTML = `<img alt="qr code undangan" src="${q.createDataURL(5, 0)}">`;
  } catch (e) { $('#qr').parentElement.hidden = true; }
}

function onPartnerConnected(p) {
  S.partner = p;
  setBanner('');
  S.ready = { me: false, partner: false };
  if (isHost()) {
    if (!frame()) setFrame(S.frames[0].id);
    const first = S.screen === 'lobby';
    if (first) { S.photos = []; S.retake = null; enterBooth(); }
    pushCfg();
    if (!first) {
      if (S.screen === 'result') { S.room.send({ type: 'nav', to: 'result', takenAt: S.takenAt }); if (S.blob) sendFinal(); }
      else S.room.send({ type: 'nav', to: 'booth', retake: S.retake });
    }
  } else {
    $('#lobby-loading').hidden = false; $('#lobby-loading').textContent = 'nyambung! nungguin host nyiapin booth…';
  }
  syncControls(); updateReady(); updateButtons();
}

/* ===================== LDR: pesan ===================== */
async function onRoomMessage(m) {
  switch (m.type) {
    case 'cfg':
      if (isHost()) return;
      S.cfg = m.cfg; if (m.serial) S.serial = m.serial;
      if (S.screen === 'lobby') { S.photos = []; S.retake = null; enterBooth(); } else afterCfgChange();
      break;
    case 'ready': S.ready.partner = !!m.v; updateReady(); break;
    case 'nav':
      if (isHost()) return;
      if (m.takenAt) S.takenAt = m.takenAt;
      if (m.to === 'booth') { S.retake = m.retake == null ? null : m.retake; enterBooth(); }
      else if (S.screen !== 'result') { if (frame()) { await goResult(); } }
      break;
    case 'restart': if (!isHost()) { S.photos = []; S.retake = null; enterBooth(); } break;
    case 'shoot': if (!isHost()) guestShoot(m); break;
    case 'photo': receivePhoto(m); break;
    case 'photoAck': S.sending = Math.max(0, S.sending - 1); updateSending(); break;
    case 'cancel':
      cancelRun(false);
      setBanner(`${S.partner ? S.partner.name : 'dia'} batalin sesinya.`);
      setTimeout(() => { if ($('#banner').textContent.includes('batalin')) setBanner(''); }, 3000);
      break;
    case 'done': if (!isHost()) { S.takenAt = m.takenAt; if (m.serial) S.serial = m.serial; S.retake = null; setRunning(false); goResult(); } break;
    case 'final': receiveFinal(m); break;
    case 'finalAck': setBanner('stripnya udah sampai ke dia.'); setTimeout(() => { if ($('#banner').textContent.includes('udah sampai')) setBanner(''); }, 2500); break;
    case 'bye': break;
  }
}

async function sendFinal() {
  if (!S.blob || !S.room) return;
  setBanner('ngirim strip ke dia…');
  // PNG 1200x3600 itu ±5 MB — di jaringan seluler bisa 10-30 detik. JPEG q0.92 ±1,1 MB
  // dan bedanya nggak kelihatan. Yang disimpan host tetap PNG; yang dikirim versi ringan.
  let out = S.blob, type = S.blob.type || 'image/png';
  if (el.canvas.width && el.canvas.height) {
    const jpg = await new Promise(r => el.canvas.toBlob(r, 'image/jpeg', 0.92));
    if (jpg) { out = jpg; type = 'image/jpeg'; }
  }
  const buf = await out.arrayBuffer();
  S.room.send({ type: 'final', buf, mime: type });
}
async function receiveFinal(m) {
  const mime = m.mime || 'image/png';
  const blob = new Blob([m.buf], { type: mime });
  const bmp = await createImageBitmap(blob);
  S.renderToken++;
  el.canvas.width = bmp.width; el.canvas.height = bmp.height;
  el.canvas.getContext('2d').drawImage(bmp, 0, 0);
  setBlob(blob, mime);
  S.room && S.room.send({ type: 'finalAck' });
}

/* ===================== keluar / reset ===================== */
function leaveAll() {
  cancelRun(false);
  if (S.room) { S.room.close(); S.room = null; }
  stopStream(S.stream); S.stream = null; el.cam.srcObject = null; S.camReady = false;
  S.remoteStream = null; el.remote.srcObject = null;
  S.partner = null; S.photos = []; S.retake = null; S.current = -1; S.mode = null; S.role = 'host'; S.serial = null;
  S.cfg.layout = 'solo'; S.cfg.swap = false;
  setBanner('');
  show('home');
}

/* ===================== tema ===================== */
const curTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function syncThemeBtn() { $('#btn-theme').textContent = curTheme() === 'dark' ? 'terang' : 'gelap'; }

/* ===================== event ===================== */
function wire() {
  $('#logo').addEventListener('click', leaveAll);
  $('#logo').addEventListener('keydown', e => { if (e.key === 'Enter') leaveAll(); });
  $('#btn-theme').addEventListener('click', () => {
    const next = curTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; lsSet(LS.theme, next); syncThemeBtn(); scheduleScribbles();
  });
  $('#btn-mode-solo').addEventListener('click', () => { S.mode = 'solo'; S.role = 'host'; S.cfg.layout = 'solo'; show('frames'); markSelected(); });
  $('#btn-mode-ldr').addEventListener('click', () => openLobby());
  $('#btn-reload-frames').addEventListener('click', loadFrames);
  $$('.tab').forEach(b => b.addEventListener('click', () => setLobbyTab(b.dataset.tab)));
  $('#lobby-fields').addEventListener('submit', submitLobby);
  $('#btn-lobby-retry').addEventListener('click', () => { $('#lobby-error').hidden = true; $('#lobby-fields').requestSubmit(); });
  $('#btn-lobby-back').addEventListener('click', leaveAll);
  $('#btn-copy').addEventListener('click', async () => {
    const t = $('#invite-link').value;
    try { await navigator.clipboard.writeText(t); } catch (e) { $('#invite-link').select(); document.execCommand('copy'); }
    $('#btn-copy').textContent = 'tersalin'; setTimeout(() => { $('#btn-copy').textContent = 'salin link'; }, 1800);
  });

  $$('[data-timer]').forEach(b => b.addEventListener('click', () => { S.cfg.timer = +b.dataset.timer; pushCfg(); syncControls(); }));
  $$('[data-layout]').forEach(b => b.addEventListener('click', () => { S.cfg.layout = b.dataset.layout; pushCfg(); afterCfgChange(); }));
  $('#btn-swap').addEventListener('click', () => { S.cfg.swap = !S.cfg.swap; pushCfg(); afterCfgChange(); });
  $('#btn-footer').addEventListener('click', () => { S.cfg.footer = !S.cfg.footer; pushCfg(); afterCfgChange(); });
  $('#btn-sound').addEventListener('click', e => {
    const on = !(e.currentTarget.getAttribute('aria-pressed') === 'true');
    e.currentTarget.setAttribute('aria-pressed', on); lbl('#btn-sound', on ? 'suara: nyala' : 'suara: mati'); setIcon('#btn-sound', on ? 'speaker' : 'speaker-off'); sfx.setSound(on);
  });
  const capInput = input => input.addEventListener('input', () => { S.cfg.caption = input.value; pushCfg(); afterCfgChange(); $$('#in-caption,#in-caption-result').forEach(i => { if (i !== input) i.value = input.value; }); });
  capInput($('#in-caption')); capInput($('#in-caption-result'));
  $('#in-booth').addEventListener('input', () => { lsSet(LS.booth, $('#in-booth').value); afterCfgChange(); });

  el.start.addEventListener('click', () => { if (S.running) cancelRun(true); else startSession(); });
  el.ready.addEventListener('click', () => {
    if (S.running) return cancelRun(true);
    if (!S.camReady) return setBanner('nyalain kameramu dulu ya.', 'bad');
    sfx.unlock();
    S.ready.me = !S.ready.me; S.room.send({ type: 'ready', v: S.ready.me }); updateReady();
  });
  $('#btn-retry').addEventListener('click', startSoloCamera);
  $('#btn-back').addEventListener('click', () => {
    if (isLdr()) return leaveAll();
    cancelRun(false);
    if (S.retake != null) { S.retake = null; goResult(); } else { stopSoloCamera(); show('frames'); markSelected(); }
  });
  $('#btn-mic').addEventListener('click', e => {
    const off = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    if (S.stream) S.stream.getAudioTracks().forEach(t => { t.enabled = !off; });
    e.currentTarget.setAttribute('aria-pressed', off); e.currentTarget.classList.toggle('off', off);
    lbl('#btn-mic', off ? 'mic mati' : 'mic'); setIcon('#btn-mic', off ? 'mic-off' : 'mic');
  });
  $('#btn-camoff').addEventListener('click', e => {
    const off = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    if (S.stream) S.stream.getVideoTracks().forEach(t => { t.enabled = !off; });
    e.currentTarget.setAttribute('aria-pressed', off); e.currentTarget.classList.toggle('off', off);
    lbl('#btn-camoff', off ? 'kamera mati' : 'kamera'); setIcon('#btn-camoff', off ? 'camera-off' : 'camera');
    if (off && S.ready.me) { S.ready.me = false; S.room && S.room.send({ type: 'ready', v: false }); updateReady(); }
  });
  $('#btn-strip-toggle').addEventListener('click', () => {
    const c = $('#strip-col'); c.classList.toggle('open');
    $('#btn-strip-toggle').textContent = c.classList.contains('open') ? 'tutup strip' : 'lihat strip';
  });
  $('#strip-col').addEventListener('click', e => { if (e.target.id === 'strip-col') { $('#strip-col').classList.remove('open'); $('#btn-strip-toggle').textContent = 'lihat strip'; } });

  $('#btn-download').addEventListener('click', () => {
    if (!S.blob) return;
    const a = document.createElement('a'); a.href = S.url; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
  });
  $('#btn-share').addEventListener('click', async () => {
    if (!S.blob) return;
    try { await navigator.share({ files: [new File([S.blob], fileName(), { type: S.mime || 'image/png' })], title: 'karebooth' }); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  });
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-sendfinal').addEventListener('click', sendFinal);
  const restart = () => {
    S.photos = []; S.retake = null;
    if (isLdr()) S.room.send({ type: 'restart' });
    if (isLdr()) enterBooth(); else { if (S.screen === 'result') enterBooth(); }
  };
  $('#btn-restart').addEventListener('click', restart);
  $('#btn-change').addEventListener('click', () => {
    if (isLdr()) restart(); else { S.photos = []; S.retake = null; show('frames'); markSelected(); }
  });
  $('#btn-restart').classList.add('host-only'); $('#btn-change').classList.add('host-only');

  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || S.screen !== 'booth' || isLdr()) return;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'BUTTON' || t === 'TEXTAREA') return;
    e.preventDefault();
    if (!S.running) startSession();
  });
  window.addEventListener('resize', scheduleScribbles);
  window.addEventListener('pagehide', () => { if (S.room) S.room.close(); stopStream(S.stream); });
}

/* ===================== init ===================== */
async function init() {
  migrateStorage();
  buildFilterChips();
  applyTilt();
  $('#in-booth').value = lsGet(LS.booth) || 'photobooth';
  wire(); syncThemeBtn();
  syncControls();
  show('home');
  const problem = checkSupport();
  if (problem) { const n = $('#support-error'); n.textContent = problem; n.hidden = false; }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleScribbles);
  await loadFrames();
  const room = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (room.length === 6) openLobby(room);
}
window.__kb = { S, goResult };
init();
