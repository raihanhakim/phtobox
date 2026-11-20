// Mode LDR: koneksi PeerJS (DataConnection + MediaConnection), sinkronisasi jam, dan pesan.
// Pustaka PeerJS dimuat dari CDN sebagai global `Peer` (lihat index.html).

import { ICE_SERVERS, PEER_OPTIONS, ROOM_PREFIX, CONNECT_TIMEOUT } from './config.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // tanpa 0/O dan 1/I
const JOIN_TRIES = 4;      // percobaan data channel sebelum menyerah kalau room memang nggak ada
const TRY_TIMEOUT = 4000;  // satu percobaan connect yang nggak ada kabar dianggap gagal
const RECALL_MAX = 4;      // percobaan ulang media call kalau video gagal tersambung

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
    this._tries = 0; this._tryConn = null;            // percobaan data channel yang sedang jalan
    this._unavailSeen = false;                        // server sudah bilang ID host nggak ada
    this._tryTimer = null;                            // batas waktu percobaan yang sedang jalan
    this._retryT = null;                              // jeda sebelum percobaan berikutnya
    this._recall = 0; this._recallTimer = null;       // percobaan ulang media call
  }

  /* ---------- waktu ---------- */
  hostNow() { return Date.now() + this.offset; }
  toLocal(hostTime) { return hostTime - this.offset; }

  /* ---------- util ---------- */
  _setStatus(s) { if (this.status !== s) { this.status = s; this.h.onStatus && this.h.onStatus(s); } }
  _every(fn, ms) { const t = setInterval(fn, ms); this._timers.push(t); return t; }
  _peerOptions() {
    const extra = PEER_OPTIONS || {};
    return {
      ...extra,
      config: {
        // bundle + pool bikin pengumpulan kandidat ICE lebih cepat dan lebih sedikit port.
        bundlePolicy: 'max-bundle',
        iceCandidatePoolSize: 4,
        iceServers: ICE_SERVERS,
        ...(extra.config || {}),
      },
    };
  }
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
      if (this.role !== 'guest') return;
      if (this._joined) {
        // sudah pernah nyambung: host kemungkinan baru ditutup
        this._misses++;
        if (this._misses >= 6) { this.h.onError && this.h.onError('closed'); this._stopRetry(); }
        return;
      }
      // host belum kebaca di server signaling (propagasi ID suka telat). Server sudah
      // bilang ID-nya nggak ada, jadi percobaan yang sedang jalan langsung dilepas dan
      // dicoba lagi sebentar lagi — jangan tunggu sampai 15 detik.
      if (this._tryConn || this._tryTimer) this._attemptFailed(true);
      this._unavailSeen = true;
      return;
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
      this.h.onError && this.h.onError('server');
    }
  }

  /* ---------- media ---------- */
  /**
   * Mulai media call tanpa nunggu data channel kebuka. Dua negosiasi (data + video)
   * jadi jalan paralel, bukan berurutan — ini yang paling ngirit waktu di jaringan seluler,
   * soalnya tiap negosiasi butuh satu putaran ICE penuh.
   */
  _startCall(hostId, force = false) {
    if (this.role !== 'guest' || this._closed || !this.peer || !this.stream) return;
    // jangan bikin call baru kalau sudah ada yang jalan — kalau call lama mati,
    // this.call sudah di-null-kan oleh handler close/error, jadi retry tetap jalan.
    if (!force && this.call) return;
    try {
      const call = this.peer.call(hostId, this.stream);
      if (call) this._bindCall(call);
    } catch (e) { console.warn('call gagal', e); }
  }

  /** Bikin ulang media call kalau video mati/gagal, jeda makin panjang tiap percobaan. */
  _maybeRecall() {
    if (this.role !== 'guest' || this._closed || !this._joined || !this.code) return;
    if (this._recallTimer || this._recall >= RECALL_MAX) return;
    const wait = 800 * Math.pow(2, this._recall);
    this._recallTimer = setTimeout(() => {
      this._recallTimer = null;
      this._recall++;
      this._startCall(ROOM_PREFIX + this.code, true);
    }, wait);
  }

  _bindCall(call) {
    const prev = this.call;
    this.call = call;                 // pasang dulu, biar close call lama tidak dianggap call aktif
    if (prev && prev !== call) { try { prev.close(); } catch (e) { /* abaikan */ } }
    call.on('stream', s => { this._recall = 0; this.h.onRemoteStream && this.h.onRemoteStream(s); });
    call.on('close', () => { if (this.call === call) { this.call = null; this._maybeRecall(); } });
    call.on('error', e => { console.warn('media error', e); if (this.call === call) { this.call = null; this._maybeRecall(); } });
    const pc = call.peerConnection;
    if (!pc) return;
    pc.addEventListener('iceconnectionstatechange', () => {
      if (this.status === 'lost' || this.call !== call) return;
      const st = pc.iceConnectionState;
      if (st === 'failed') { this._setStatus('weak'); this._maybeRecall(); }
      else if (st === 'disconnected') this._setStatus('weak');
      else if (st === 'connected' || st === 'completed') { if (this.conn && this.conn.open) this._setStatus('connected'); }
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
  /** Daftar ke server signaling lebih awal, biar bisa barengan sama buka kamera. */
  preopen() {
    if (!this._prepP) {
      this._prepP = this._openPeer(undefined).then(() => true, e => { this._prepP = null; throw e; });
    }
    return this._prepP;
  }

  /** Stream datang belakangan (kamera masih dibuka) — nyalakan video begitu siap. */
  attachStream(stream) {
    this.stream = stream;
    if (this.role === 'guest' && this.code && this.peer) this._startCall(ROOM_PREFIX + this.code);
  }

  join(code) {
    this.code = code; this._joined = false;
    return new Promise(async (resolve, reject) => {
      this._joinPromise = { resolve, reject };
      try { await (this._prepP ? this._prepP : this._openPeer(undefined)); }
      catch (e) { return reject(e === 'taken' ? 'server' : e); }
      this._startPing();
      // video duluan, barengan sama data channel — jangan nunggu handshake selesai.
      this._startCall(ROOM_PREFIX + code);
      this._tryConnect();
    });
  }
  _joinFail(kind) {
    this._clearConnectTimer();
    clearTimeout(this._tryTimer); this._tryTimer = null;
    clearTimeout(this._retryT); this._retryT = null;
    this._tryConn = null;
    if (this._joinPromise) { this._joinPromise.reject(kind); this._joinPromise = null; }
  }
  _clearConnectTimer() { clearTimeout(this._ct); this._ct = null; }

  /**
   * Satu percobaan connect. PeerJS cloud cuma memunculkan `peer-unavailable` sekali untuk
   * satu ID, jadi percobaan berikutnya bisa menggantung tanpa kabar. Karena itu tiap
   * percobaan punya batas waktunya sendiri: gagal (atau lewat TRY_TIMEOUT) langsung
   * dilepas dan dicoba lagi. Total tetap dibatasi CONNECT_TIMEOUT.
   */
  _tryConnect() {
    if (this._closed || !this.peer) return;
    if (this.conn && this.conn.open) return;          // sudah nyambung
    if (this._tryConn || this._retryT) return;        // percobaan lain sedang jalan
    const hostId = ROOM_PREFIX + this.code;
    const rejoin = this._joined;                      // pernah nyambung = menyambung ulang
    let conn;
    try { conn = this.peer.connect(hostId, { serialization: 'binary', reliable: true }); }
    catch (e) { console.warn('connect gagal', e); return this._attemptFailed(true); }

    this._tryConn = conn;
    if (!rejoin) this._ct = this._ct || setTimeout(() => { if (!this._joined) this._joinFail(this._unavailSeen ? 'notfound' : 'timeout'); }, CONNECT_TIMEOUT);

    clearTimeout(this._tryTimer);
    // Kalau server sudah bilang ID-nya nggak ada, jangan kasih tempo panjang tiap percobaan.
    const tryMs = this._unavailSeen ? 1400 : TRY_TIMEOUT;
    this._tryTimer = setTimeout(() => this._attemptFailed(false), tryMs);

    conn.on('open', () => {
      clearTimeout(this._tryTimer);
      conn.send({ type: 'hello', cid: this.cid, name: this.me.name, city: this.me.city, tz: this.me.tz });
      this._startCall(hostId, rejoin);   // menyambung ulang: paksa video baru
      // host menerima tapi belum jawab: jangan gantung selamanya
      this._tryTimer = setTimeout(() => this._attemptFailed(false), TRY_TIMEOUT);
    });
    conn.on('data', d => {
      if (d && d.type === 'welcome') {
        clearTimeout(this._tryTimer); this._tryTimer = null;
        clearTimeout(this._retryT); this._retryT = null;
        this._tries = 0; this._tryConn = null; this._unavailSeen = false; this._rejoins = 0;
        this.conn = conn; this._misses = 0; this._stopRetry();
        this.partner = { name: d.name, city: d.city, tz: d.tz };
        this.lastPong = Date.now();
        this._clearConnectTimer();
        this._setStatus('connected');
        const first = !this._joined;
        this._joined = true;
        this.syncClock();
        this._startCall(hostId);   // kalau video belum jalan, coba sekali lagi
        if (first && this._joinPromise) { this._joinPromise.resolve(this.partner); this._joinPromise = null; }
        this.h.onConnected && this.h.onConnected(this.partner);
        return;
      }
      if (d && d.type === 'full') { this._joinFail('full'); this.h.onError && this.h.onError('full'); this._stopRetry(); return; }
      this._onData(d);
    });
    conn.on('close', () => {
      if (this.conn === conn) this._lost();
      else if (this._tryConn === conn) this._attemptFailed(true);
    });
    conn.on('error', e => { console.warn('conn error', e); if (this._tryConn === conn) this._attemptFailed(true); });
  }

  /** Lepas percobaan yang gagal/menggantung, lalu jadwalkan percobaan berikutnya. */
  _attemptFailed(immediate = false) {
    if (this._closed) return;
    if (this.conn && this.conn.open) return;              // sudah nyambung, abaikan
    if (!this._tryConn && !this._tryTimer) return;        // sudah ditangani; error kedua diabaikan
    clearTimeout(this._tryTimer); this._tryTimer = null;
    const conn = this._tryConn; this._tryConn = null;
    if (conn) { try { conn.close(); } catch (e) { /* abaikan */ } }

    // Kalau cuma menyambung ulang, jangan pernah menyerah: room-nya ada, jaringannya yang goyang.
    // Tapi jedanya harus makin panjang, jangan membanjiri server signaling tiap 150 ms.
    if (!this._joined) {
      if (this._tries >= JOIN_TRIES) return this._joinFail('notfound');
      this._tries++;
    } else {
      this._rejoins = Math.min((this._rejoins || 0) + 1, 10);
    }
    const n = this._joined ? this._rejoins : this._tries;
    const wait = immediate ? Math.min(200 * n + 200, 4000) : Math.min(400 * n + 350, 4000);
    clearTimeout(this._retryT);
    this._retryT = setTimeout(() => { this._retryT = null; this._tryConnect(); }, wait);
  }

  _lost() {
    if (this._closed) return;
    this.conn = null;
    clearTimeout(this._tryTimer); this._tryTimer = null;
    clearTimeout(this._retryT); this._retryT = null;
    this._tryConn = null; this._tries = 0; this._rejoins = 0;
    this._setStatus('lost');
    this.h.onLost && this.h.onLost(this.partner);
    if (this.role === 'guest' && !this._retry) {
      this._retry = setInterval(() => { if (!this.conn) this._tryConnect(); }, 3000);
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
    clearTimeout(this._recallTimer); this._recallTimer = null;
    this._timers.forEach(clearInterval); this._timers = [];
    this._clearConnectTimer();
    clearTimeout(this._tryTimer); this._tryTimer = null;
    clearTimeout(this._retryT); this._retryT = null;
    try { this.send({ type: 'bye' }); } catch (e) { /* abaikan */ }
    try { if (this.call) this.call.close(); } catch (e) { /* abaikan */ }
    try { if (this.conn) this.conn.close(); } catch (e) { /* abaikan */ }
    try { if (this._tryConn && this._tryConn !== this.conn) this._tryConn.close(); } catch (e) { /* abaikan */ }
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* abaikan */ }
    this.peer = this.conn = this.call = this._tryConn = null;
  }
}
