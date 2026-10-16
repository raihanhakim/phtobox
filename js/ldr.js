// Mode LDR: koneksi PeerJS (DataConnection + MediaConnection), sinkronisasi jam, dan pesan.
// Pustaka PeerJS dimuat dari CDN sebagai global `Peer` (lihat index.html).

import { ICE_SERVERS, PEER_OPTIONS, ROOM_PREFIX, CONNECT_TIMEOUT } from './config.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // tanpa 0/O dan 1/I
export function makeCode(n = 6) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, v => ALPHABET[v % ALPHABET.length]).join('');
}
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '').replace(/I/g, '').slice(0, 6);
}

/**
 * Room dua orang. role: 'host' | 'guest'.
 * handlers: onStatus(status), onConnected(partner), onLost(partner), onMessage(msg),
 *           onRemoteStream(stream), onError(kind)
 * status: 'connecting' | 'connected' | 'weak' | 'lost'
 * kind error: 'server' | 'notfound' | 'full' | 'timeout' | 'closed'
 */
export class Room {
  constructor({ role, me, stream, handlers }) {
    this.role = role; this.me = me; this.stream = stream; this.h = handlers || {};
    this.cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.peer = null; this.conn = null; this.call = null; this.code = null;
    this.partner = null; this.status = 'connecting';
    this.offset = 0;                 // waktuHost - waktuLokal (ms); host = 0
    this.guestCid = null;
    this.lastPong = 0; this.rtt = null;
    this._timers = []; this._closed = false; this._misses = 0; this._syncWait = new Map();
  }

  /* ---------- waktu ---------- */
  hostNow() { return Date.now() + this.offset; }
  toLocal(hostTime) { return hostTime - this.offset; }

  /* ---------- util ---------- */
  _setStatus(s) { if (this.status !== s) { this.status = s; this.h.onStatus && this.h.onStatus(s); } }
  _every(fn, ms) { const t = setInterval(fn, ms); this._timers.push(t); return t; }
  _peerOptions() { return { config: { iceServers: ICE_SERVERS }, ...PEER_OPTIONS }; }
  send(msg) { try { if (this.conn && this.conn.open) { this.conn.send(msg); return true; } } catch (e) { console.warn('send gagal', e); } return false; }

  _openPeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof Peer === 'undefined') return reject('server');
      let done = false;
      const p = new Peer(id, this._peerOptions());
      const to = setTimeout(() => { if (!done) { done = true; try { p.destroy(); } catch (e) { /* abaikan */ } reject('server'); } }, 12000);
      p.on('open', () => { if (done) return; done = true; clearTimeout(to); this.peer = p; this._bindPeer(p); resolve(); });
      p.on('error', e => {
        if (!done) { done = true; clearTimeout(to); try { p.destroy(); } catch (x) { /* abaikan */ } return reject(e.type === 'unavailable-id' ? 'taken' : 'server'); }
        this._onPeerError(e);
      });
    });
  }

  _bindPeer(p) {
    p.on('disconnected', () => { if (!this._closed) { try { p.reconnect(); } catch (e) { /* abaikan */ } } });
    if (this.role === 'host') {
      p.on('connection', c => this._onIncoming(c));
      p.on('call', call => { call.answer(this.stream); this._bindCall(call); });
    }
  }

  _onPeerError(e) {
    if (e.type === 'peer-unavailable') {
      if (this.role === 'guest') {
        this._misses++;
        if (!this._joined) return this._joinFail('notfound');
        if (this._misses >= 6) { this.h.onError && this.h.onError('closed'); this._stopRetry(); }
      }
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
      this.h.onError && this.h.onError('server');
    }
  }

  _bindCall(call) {
    if (this.call && this.call !== call) { try { this.call.close(); } catch (e) { /* abaikan */ } }
    this.call = call;
    call.on('stream', s => this.h.onRemoteStream && this.h.onRemoteStream(s));
    call.on('close', () => { if (this.call === call) this.call = null; });
    call.on('error', e => console.warn('media error', e));
    const pc = call.peerConnection;
    if (pc) pc.addEventListener('iceconnectionstatechange', () => {
      if (this.status === 'lost') return;
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') this._setStatus('weak');
      else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') { if (this.conn && this.conn.open) this._setStatus('connected'); }
    });
  }

  /* ---------- host ---------- */
  async createRoom() {
    for (let i = 0; i < 6; i++) {
      const code = makeCode();
      try { await this._openPeer(ROOM_PREFIX + code); this.code = code; break; }
      catch (e) { if (e === 'taken') continue; throw e; }
    }
    if (!this.code) throw 'server';
    this._startPing();
    return this.code;
  }

  _onIncoming(c) {
    let accepted = false;
    c.on('data', d => {
      if (!accepted) {
        if (!d || d.type !== 'hello') return;
        if (this.conn && this.conn.open && this.guestCid !== d.cid) {
          try { c.send({ type: 'full' }); } catch (e) { /* abaikan */ }
          setTimeout(() => { try { c.close(); } catch (e) { /* abaikan */ } }, 400);
          return;
        }
        accepted = true;
        const old = this.conn;
        this.conn = c; this.guestCid = d.cid;
        if (old && old !== c) { try { old.close(); } catch (e) { /* abaikan */ } }
        this.partner = { name: d.name, city: d.city, tz: d.tz };
        c.send({ type: 'welcome', name: this.me.name, city: this.me.city, tz: this.me.tz });
        this.lastPong = Date.now();
        this._setStatus('connected');
        this.h.onConnected && this.h.onConnected(this.partner);
        return;
      }
      this._onData(d);
    });
    c.on('close', () => { if (this.conn === c) this._lost(); });
    c.on('error', e => console.warn('conn error', e));
  }

  /* ---------- guest ---------- */
  join(code) {
    this.code = code; this._joined = false;
    return new Promise(async (resolve, reject) => {
      this._joinPromise = { resolve, reject };
      try { await this._openPeer(undefined); } catch (e) { return reject(e === 'taken' ? 'server' : e); }
      this._startPing();
      this._connect();
    });
  }
  _joinFail(kind) { if (this._joinPromise) { this._joinPromise.reject(kind); this._joinPromise = null; } this._clearConnectTimer(); }
  _clearConnectTimer() { clearTimeout(this._ct); }

  _connect() {
    if (this._closed || !this.peer) return;
    const hostId = ROOM_PREFIX + this.code;
    const conn = this.peer.connect(hostId, { serialization: 'binary', reliable: true });
    this._pending = conn;
    this._clearConnectTimer();
    if (!this._joined) this._ct = setTimeout(() => { if (!this._joined) { try { conn.close(); } catch (e) { /* abaikan */ } this._joinFail('timeout'); } }, CONNECT_TIMEOUT);
    conn.on('open', () => {
      conn.send({ type: 'hello', cid: this.cid, name: this.me.name, city: this.me.city, tz: this.me.tz });
      try { this._bindCall(this.peer.call(hostId, this.stream)); } catch (e) { console.warn('call gagal', e); }
    });
    conn.on('data', d => {
      if (d && d.type === 'welcome') {
        this.conn = conn; this._misses = 0; this._stopRetry();
        this.partner = { name: d.name, city: d.city, tz: d.tz };
        this.lastPong = Date.now();
        this._clearConnectTimer();
        this._setStatus('connected');
        const first = !this._joined;
        this._joined = true;
        this.syncClock();
        if (first && this._joinPromise) { this._joinPromise.resolve(this.partner); this._joinPromise = null; }
        this.h.onConnected && this.h.onConnected(this.partner);
        return;
      }
      if (d && d.type === 'full') { this._joinFail('full'); this.h.onError && this.h.onError('full'); this._stopRetry(); return; }
      this._onData(d);
    });
    conn.on('close', () => { if (this.conn === conn) this._lost(); });
    conn.on('error', e => console.warn('conn error', e));
  }

  _lost() {
    if (this._closed) return;
    this.conn = null;
    this._setStatus('lost');
    this.h.onLost && this.h.onLost(this.partner);
    if (this.role === 'guest' && !this._retry) {
      this._retry = setInterval(() => { if (!this.conn) this._connect(); }, 3000);
    }
  }
  _stopRetry() { clearInterval(this._retry); this._retry = null; }

  /* ---------- pesan, ping, sinkron jam ---------- */
  _onData(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.type) {
      case 'ping': this.send({ type: 'pong', t: d.t }); return;
      case 'pong': this.lastPong = Date.now(); this.rtt = Date.now() - d.t; return;
      case 'tping': this.send({ type: 'tpong', i: d.i, t0: d.t0, th: Date.now() }); return;
      case 'tpong': { const w = this._syncWait.get(d.i); if (w) { this._syncWait.delete(d.i); w({ t0: d.t0, th: d.th, t1: Date.now() }); } return; }
      default: this.h.onMessage && this.h.onMessage(d);
    }
  }

  _startPing() {
    this._every(() => {
      if (!this.conn || !this.conn.open) return;
      this.send({ type: 'ping', t: Date.now() });
      const idle = Date.now() - this.lastPong;
      if (idle > 9000 && this.status === 'connected') this._setStatus('weak');
      else if (idle <= 9000 && this.status === 'weak' && !this._iceBad()) this._setStatus('connected');
    }, 3000);
  }
  _iceBad() { const pc = this.call && this.call.peerConnection; return !!pc && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed'); }

  /** Tamu mengukur selisih jam dengan host: 5x ping-pong, pakai sampel RTT terkecil. */
  async syncClock() {
    if (this.role !== 'guest') { this.offset = 0; return 0; }
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const s = await new Promise(res => {
        const to = setTimeout(() => { this._syncWait.delete(i); res(null); }, 2000);
        this._syncWait.set(i, v => { clearTimeout(to); res(v); });
        this.send({ type: 'tping', i, t0: Date.now() });
      });
      if (s) samples.push({ rtt: s.t1 - s.t0, offset: s.th - (s.t0 + s.t1) / 2 });
      await new Promise(r => setTimeout(r, 60));
    }
    if (samples.length) { samples.sort((a, b) => a.rtt - b.rtt); this.offset = samples[0].offset; this.syncRtt = samples[0].rtt; }
    return this.offset;
  }

  close() {
    this._closed = true;
    this._stopRetry();
    this._timers.forEach(clearInterval); this._timers = [];
    this._clearConnectTimer();
    try { this.send({ type: 'bye' }); } catch (e) { /* abaikan */ }
    try { if (this.call) this.call.close(); } catch (e) { /* abaikan */ }
    try { if (this.conn) this.conn.close(); } catch (e) { /* abaikan */ }
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* abaikan */ }
    this.peer = this.conn = this.call = null;
  }
}
