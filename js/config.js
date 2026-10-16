// Konfigurasi koneksi mode LDR. Edit berkas ini untuk menambah server TURN.

export const ROOM_PREFIX = 'karebooth-';

// STUN gratis dari Google. Banyak jaringan seluler (terutama di Indonesia) memakai NAT yang
// ketat, sehingga video tidak bisa tersambung tanpa server TURN.
// Isi bagian TURN di bawah lalu hapus tanda komentar. Kredensial di berkas statis ini
// bisa dilihat siapa saja yang membuka situs, jadi pakai kredensial dengan kuota terbatas.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // {
  //   urls: ['turn:NAMA-SERVER-TURN:443?transport=tcp', 'turns:NAMA-SERVER-TURN:443?transport=tcp'],
  //   username: 'USERNAME',
  //   credential: 'PASSWORD',
  // },
];

// Opsi tambahan untuk PeerJS (mis. server signaling sendiri). Kosong = PeerJS cloud gratis.
// Contoh: { host: 'peer.contoh.com', port: 443, secure: true, path: '/' }
export const PEER_OPTIONS = (typeof window !== 'undefined' && window.__PEER_OPTIONS) || {};

// Batas waktu (ms) menunggu koneksi tersambung.
export const CONNECT_TIMEOUT = 15000;
