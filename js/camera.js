// Akses kamera/mikrofon dan pengambilan foto mentah.

export function checkSupport() {
  if (!window.isSecureContext) {
    return 'kamera cuma bisa dipakai lewat https atau localhost. buka halaman ini lewat alamat https:// atau http://localhost.';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'browsermu belum bisa akses kamera. coba chrome, safari, firefox, atau edge versi terbaru.';
  }
  return null;
}

export function describeError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') {
    return 'izinin kamera dulu ya. buka ikon gembok di address bar, izinkan kamera dan mic, lalu tekan "coba lagi".';
  }
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') {
    return 'kameranya nggak ketemu. pastikan perangkatmu punya kamera yang terpasang, lalu tekan "coba lagi".';
  }
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') {
    return 'kameranya lagi dipakai aplikasi lain. tutup aplikasi atau tab yang lagi pakai kamera, lalu tekan "coba lagi".';
  }
  return 'kameranya nggak bisa nyala (' + (n || 'kesalahan tidak dikenal') + '). tekan "coba lagi".';
}

/** Buka kamera depan. Dengan audio=true, mic memakai echoCancellation + noiseSuppression. */
export async function openCamera({ audio = false } = {}) {
  const problem = checkSupport();
  if (problem) throw Object.assign(new Error(problem), { userMessage: problem });
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    });
  } catch (e) {
    throw Object.assign(e, { userMessage: describeError(e) });
  }
}

export function stopStream(stream) {
  if (stream) stream.getTracks().forEach(t => t.stop());
}

/** Foto mentah resolusi penuh dari elemen <video> lokal, sudah di-mirror, tanpa filter. */
export function captureRaw(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  return c;
}
