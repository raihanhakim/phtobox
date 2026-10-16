# karebooth

photobooth kecil-kecilan. 3 pose, 1 strip. Situs statis (HTML + CSS + JavaScript vanilla, ES modules, tanpa build step, tanpa backend sendiri) dengan 8 frame photostrip orisinal dan dua mode:

1. **foto sendiri**: pilih frame, 3 pose otomatis, hasil 1200×3600 px.
2. **foto bareng ldr**: dua orang di kota berbeda terhubung lewat video live (WebRTC via [PeerJS](https://peerjs.com)), countdown sinkron, dan hasilnya satu strip berisi foto keduanya.

```
index.html  style.css  vercel.json
js/app.js       alur UI dan state
js/camera.js    akses kamera/mic dan capture
js/compose.js   render strip, filter piksel, caption, footer
js/slots.js     deteksi lubang foto otomatis dari alpha
js/ldr.js       koneksi PeerJS, sinkronisasi jam, pesan
js/audio.js     efek suara Web Audio
js/config.js    ICE servers (STUN/TURN), mudah diedit
frames/frames.json + frames/*.svg
```

Pustaka dari CDN (versi dikunci): PeerJS 1.5.4, qrcode-generator 1.4.4, rough.js 4.6.6 (coretan tangan di UI). Font dari Google Fonts: Bagel Fat One, IBM Plex Mono, Gochi Hand (UI), plus font caption tiap frame.

## Tampilan

Arahnya "barang cetakan, bukan aplikasi": kertas daur ulang, tinta hitam, satu aksen merah ala riso, selotip, stempel, dan coretan spidol. Semua warna ada sebagai variabel di `:root` pada `style.css` (`--kertas`, `--tinta`, `--merah`, `--biru`, `--pensil`). Mode gelap ("kertas hitam") mengikuti pengaturan sistem dan bisa diganti lewat tombol **gelap/terang** di header (pilihan disimpan).

Tagline halaman awal ada di `index.html` (`.tagline`). Rotasi kecil pada elemen memakai seed tetap per elemen (atribut `data-tilt`), jadi tidak berubah tiap reload.

## Tes lokal

Kamera tidak jalan lewat `file://` dan ES modules butuh server, jadi:

```bash
npx serve .
```

Buka `http://localhost:3000`. `localhost` dianggap aman oleh browser, jadi kamera boleh dipakai tanpa HTTPS. Mode foto sendiri bisa dicoba penuh di sini.

Untuk mencoba LDR di satu laptop, buka dua jendela browser terpisah (tab latar belakang diperlambat browser). Chrome punya kamera palsu untuk uji coba: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.

## Deploy ke Vercel

**(a) lewat GitHub**
1. Push folder ini ke repositori GitHub.
2. Buka [vercel.com/new](https://vercel.com/new), import repositorinya.
3. Framework Preset: **Other**. Kosongkan Build Command dan Output Directory, lalu Deploy.

**(b) lewat Vercel CLI**
```bash
npx vercel          # preview
npx vercel --prod   # produksi
```

`vercel.json` menambahkan header `Permissions-Policy: camera=(self), microphone=(self)`. Vercel otomatis memakai HTTPS.

## Menguji mode LDR

Kamera di HP butuh HTTPS, jadi **deploy dulu ke Vercel** lalu:

1. Di perangkat A buka situs, pilih **foto bareng ldr**, isi nama dan kota, tekan **bikin room**. Izinkan kamera dan mikrofon.
2. Bagikan link undangan (salin, WhatsApp, atau QR) ke perangkat B. B isi nama dan kota lalu **masuk**.
3. Host memilih frame, layout, filter, timer, dan caption (tamu hanya melihat). Keduanya tekan **siap**, lalu host menekan **jepret**.
4. Hasilnya muncul di kedua sisi. Host bisa mengetuk satu foto untuk mengulangnya bareng-bareng dan menekan **kirim strip ke dia** supaya PNG final identik.

Foto dikirim langsung antar perangkat (WebRTC data channel). Server PeerJS hanya dipakai untuk saling menemukan (signaling). Tiap sisi memotret dari kamera lokalnya dengan resolusi penuh, bukan dari video WebRTC yang sudah terkompresi.

Perilaku penting:
- Satu room maksimal 2 orang; orang ketiga melihat "room-nya udah penuh".
- Kalau salah satu terputus di tengah sesi, sesi dibatalkan dan room tetap dibuka; tamu otomatis mencoba tersambung lagi.
- Jam kedua perangkat diukur (5× ping-pong, sampel RTT terkecil) supaya countdown berakhir di waktu yang sama.
- ID PeerJS room: `karebooth-<KODE>`.

## Mengisi TURN (`js/config.js`)

STUN gratis cukup untuk banyak jaringan WiFi, tetapi banyak jaringan seluler (termasuk di Indonesia) memakai NAT yang ketat sehingga video tidak tersambung tanpa server **TURN**. Edit `ICE_SERVERS` di `js/config.js`, hapus tanda komentar pada blok TURN, lalu isi alamat, username, dan password.

Layanan TURN dengan paket gratis (cek syarat terbaru di situsnya): [Metered](https://www.metered.ca/tools/openrelay/), [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/), atau [Twilio Network Traversal](https://www.twilio.com/docs/stun-turn) (berbayar per pemakaian). Bisa juga memasang `coturn` sendiri.

> **Peringatan:** `js/config.js` adalah berkas statis, jadi username dan password TURN bisa dilihat siapa saja yang membuka situs. Pakai kredensial dengan kuota terbatas dan ganti secara berkala.

Server signaling bisa diganti dengan PeerServer sendiri lewat `PEER_OPTIONS` di berkas yang sama. Kalau koneksi tidak tersambung dalam 15 detik, aplikasi menyarankan ganti jaringan (misalnya dari data seluler ke wifi) atau mengisi TURN.

## Nomor seri dan data di browser

Tiap strip yang selesai mendapat nomor seri `no. 0001`, `no. 0002`, dan seterusnya, dicetak kecil di tepi bawah bersama cap "karebooth". Di mode LDR dipakai nomor seri host. Data disimpan di `localStorage` (semua dibungkus try/catch): `karebooth:name`, `karebooth:city`, `karebooth:booth`, `karebooth:serial`, `karebooth:theme`. Data dari versi lama (`sb:*`, `photobooth:name`) dipindahkan otomatis ke key baru lalu dihapus.

## Menambah frame baru

1. Buat gambar frame **SVG atau PNG** rasio 1:3 (600×1800 untuk SVG, 1200×3600 untuk PNG) dengan **lubang transparan** untuk foto. Sisakan area ±180 px di bawah untuk caption, footer (y≈1724 dan 1760), dan cap serial (y≈1787). Jangan taruh teks di dalam SVG; teks digambar oleh app. Ukuran dan posisi lubang boleh berbeda-beda tiap frame.
2. Taruh berkas di `frames/`.
3. Tambahkan entri di `frames/frames.json`:

```json
{
  "id": "frame-saya",
  "name": "Frame Saya",
  "file": "frame-saya.svg",
  "footerColor": "#222222",
  "caption": { "text": "caption saya", "font": "Caveat", "size": 50, "color": "#222222", "x": 300, "y": 1668, "rotate": 0 },
  "slots": []
}
```

- `slots: []` membuat lubang **dideteksi otomatis** dari alpha (piksel alpha < 230; komponen < 1% atau > 60% luas gambar dibuang; diurutkan atas ke bawah). Atau tulis manual bounding box tiap lubang (koordinat 600×1800), `{"x":60,"y":50,"w":480,"h":480}`. Untuk lubang miring, bounding box harus mencakup seluruh lubang. Lubang sebaiknya cukup besar untuk dua orang (mode LDR membagi kotak ini).
- `caption.font`: nama font Google Fonts. Tambahkan juga ke tag `<link>` Google Fonts di `index.html`.
- `defaultFilter` (opsional): filter yang otomatis dipilih saat frame dipilih (`"analog"` dipakai Roll Film 35mm).
- Frame yang dipilih tampil di tali jemuran dengan nomor 1, 2, 3 di tiap lubang, digambar app di atas latar abu-abu hangat.
