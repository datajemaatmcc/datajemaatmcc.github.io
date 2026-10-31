# CMS Data Jemaat Gereja

Aplikasi web statis (tanpa server) untuk mengelola data jemaat: profil gereja,
data jemaat, keuangan per proyek kas, inventaris/logistik, laporan analitik,
serta pengaturan (profil, kategori, user, audit trail).

- **Frontend**: HTML + CSS + JavaScript ES Module (tanpa build step)
- **Database**: Cloud Firestore (NoSQL) — diakses lewat Firebase JS SDK modular v10 via CDN
- **Autentikasi**: Firebase Authentication (Email/Password)
- **Grafik**: Chart.js 4 via CDN
- **Hosting**: GitHub Pages (statis)

---

## 1. Menjalankan secara lokal

Aplikasi memakai ES module, jadi **tidak bisa dibuka lewat dobel-klik (`file://`)** —
browser memblokirnya. Jalankan server lokal dari folder proyek:

```bash
npx serve .
# atau
python -m http.server 8123
```

Lalu buka alamat yang muncul (mis. `http://localhost:3000`).

---

## 2. Struktur proyek

```
index.html          ← shell: halaman login + sidebar/header + wadah tiap modul
css/style.css       ← tema (sidebar biru gelap, kartu radius 14px)
js/
  firebase-config.js← kredensial Firebase + flag IS_CONFIG_READY
  auth.js           ← login/logout, watchAuth, peta permission per role
  app.js            ← guard login, navigasi modul, header, modal
  utils.js          ← esc() anti-XSS, format Rp/tanggal, modal, toast, konfirmasi
  i18n.js           ← kamus ID/EN + t()
  store.js          ← audit trail, dokumen ringkasan (hemat kuota), ekspor CSV
  dashboard.js      ← MODUL 1
  jemaat.js         ← MODUL 2 (form tambah/ubah, import Excel, ekspor CSV)
  keuangan.js       ← MODUL 3
  logistik.js       ← MODUL 4
  laporan.js        ← MODUL 5
  pengaturan.js     ← MODUL 6 (4 tab)
  absensi.js        ← MODUL 7 (jadwal buka-tutup WIB, checklist, kirim ke Google Sheets)
```

---

## 3. Menyiapkan Firebase

### 3.1 Buat proyek & aktifkan Email/Password

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Menu kiri → **Build → Authentication → Get started**.
3. Tab **Sign-in method** → **Email/Password** → **Enable** → Save.
4. Tab **Users** → **Add user** → isi email & sandi → salin **User UID**-nya.

### 3.2 Buat database Firestore

1. Menu kiri → **Build → Firestore Database → Create database**.
2. Pilih **Production mode** (bukan test mode — test mode terbuka 30 hari).
3. Lokasi: **`asia-southeast1` (Singapore)** supaya cepat dari Indonesia.

### 3.3 Tempel Security Rules

**Firestore → tab Rules → tempel ini → Publish:**

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function masuk() {
      return request.auth != null;
    }

    function profil() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }

    function aktif() {
      return masuk() && (!('aktif' in profil()) || profil().aktif == true);
    }

    function peran() {
      return aktif() ? profil().role : 'TidakAda';
    }

    function admin() {
      return peran() == 'Admin';
    }

    // Siapa boleh MENULIS modul tertentu (sumber: js/auth.js → PERMISSIONS)
    function bolehTulis(modul) {
      return admin()
        || (peran() == 'Bendahara' && modul == 'keuangan')
        || (peran() == 'Sekretaris' && modul == 'jemaat')
        || (peran() == 'Sekretaris' && modul == 'logistik');
    }

    /* 1. Data Jemaat */
    match /jemaat/{id} {
      allow read: if aktif();
      allow create, update, delete: if aktif() && bolehTulis('jemaat');
    }

    /* 2. Keuangan */
    match /proyek/{id} {
      allow read: if aktif();
      allow create, update, delete: if aktif() && bolehTulis('keuangan');
    }
    match /transaksi/{id} {
      allow read: if aktif();
      allow create, update, delete: if aktif() && bolehTulis('keuangan');
    }

    /* 3. Logistik */
    match /aset/{id} {
      allow read: if aktif();
      allow create, update, delete: if aktif() && bolehTulis('logistik');
    }

    /* 4. Dokumen ringkasan (efisiensi kuota) */
    // ringkasan/jemaat     → dihitung oleh modul Data Jemaat
    // ringkasan/kas_total  → dihitung oleh modul Keuangan (semua kas)
    // ringkasan/kas_{id}   → dihitung oleh modul Keuangan (per proyek)
    match /ringkasan/{docId} {
      allow read: if aktif();
      allow create, update: if aktif()
        && ((docId == 'jemaat' && bolehTulis('jemaat'))
         || (docId.startsWith('kas_') && bolehTulis('keuangan')));
    }

    /* 5. Pengaturan */
    match /pengaturan/{docId} {
      allow read: if aktif();
      allow create, update, delete: if admin();
    }

    /* 6. Manajemen User */
    match /users/{uid} {
      allow read: if aktif() && (request.auth.uid == uid || admin());
      allow create, update, delete: if admin();
    }

    /* 7. Audit Trail: semua role aktif boleh membaca & menambah,
          tidak ada yang boleh mengubah/menghapus */
    match /audit_log/{id} {
      allow read: if aktif();
      allow create: if masuk();
      allow update, delete: if false;
    }
  }
}
```

> Rules ini dibuat **identik dengan `PERMISSIONS` di `js/auth.js`**: tampilan
> (tombol yang disembunyikan) dan pertahanan server selalu sejalan. Kalau
> menambah/mengubah peran, ubah **keduanya**.

### 3.4 Buat dokumen admin pertama

Karena login menolak user yang tidak punya dokumen profil:

1. **Authentication → Users** → salin **User UID**.
2. **Firestore → tab Data → Start collection**:
   - Collection ID: `users`
   - Document ID: **tempel UID** (jangan Auto-ID!)
   - Field:
     | Nama | Tipe | Nilai |
     |---|---|---|
     | `nama` | string | Nama lengkap |
     | `email` | string | email login yang sama |
     | `role` | string | `Admin` |
     | `aktif` | boolean | `true` |
3. **Save** → coba login lagi.

### 3.5 Kredensial aplikasi

`js/firebase-config.js` sudah berisi konfigurasi proyek. Kalau ganti proyek,
tempel lagi dari **Project settings → Your apps → SDK setup and configuration**.

> `apiKey` Firebase **bukan rahasia** — yang menjaga data adalah Security Rules.
> Tetapi untuk aplikasi publik, batasi pemakaiannya:
> **Google Cloud Console → APIs & Credentials → pilih key →
> Application restrictions → HTTP referrers** → isi domain GitHub Pages Anda.

---

## 4. Model data Firestore

| Koleksi / Dokumen | Field penting |
|---|---|
| `jemaat/{id}` | `nama`, `namaPanggilan?`, `jenisKelamin` (L/P), `tanggalLahir`, `tanggalNikah?`, `wilayah`, `noHp`, `status` (Aktif/Pasif), **turunan**: `ultahMD` & `annivMD` (`MM-DD`), `umur`, `kategoriUmur`, `createdAt`, `updatedAt`. Data lama boleh masih menyimpan `nik`/`noKk` — dua field itu sudah dihapus dari form maupun import. |
| `transaksi/{id}` | `proyekId`, `tanggal`, `jenis` (masuk/keluar), `kategori`, `keterangan`, `referensi`, `nominal` |
| `proyek/{id}` | `nama`, `deskripsi`, `createdAt` |
| `aset/{id}` | `nama`, `kategori`, `jumlah`, `kondisi` (Bagus/Perlu Perbaikan/Rusak), `lokasi`, `hargaSatuan` |
| `pengaturan/profil` | `namaGereja`, `logoUrl`, `alamat`, `deskripsi`, `struktur{gembala,ketuaMajelis,bendahara}`, `batasUmur{anak,remaja,pemuda,lansia}`, `templateUlangTahun`, `templateAnniversary` |
| `pengaturan/kategori` | `keuangan[]`, `inventaris[]`, `wilayah[]` |
| `users/{uid}` | `nama`, `email`, `role` (Admin/Bendahara/Sekretaris/Viewer), `aktif` |
| `audit_log/{id}` | `userId`, `userName`, `aksi`, `koleksi`, `docId`, `detail`, `waktu` |
| `ringkasan/jemaat` | `total`, `aktif`, `pasif`, `laki`, `perempuan`, `perWilayah{}`, `perUmur{}`, `perBulanUlangTahun[12]` |
| `ringkasan/kas_total` | `pemasukan`, `pengeluaran`, `saldo`, `perBulan{"YYYY-MM":{masuk,keluar}}` |
| `ringkasan/kas_{proyekId}` | sama, untuk satu proyek kas |

---

## 5. Peran & izin

| Aksi | Admin | Bendahara | Sekretaris | Viewer |
|---|:--:|:--:|:--:|:--:|
| Semua modul (baca) | ✅ | ✅ | ✅ | ✅ |
| Data Jemaat (tulis) | ✅ | — | ✅ | — |
| Keuangan (tulis) | ✅ | ✅ | — | — |
| Logistik (tulis) | ✅ | — | ✅ | — |
| Absensi (tulis) | ✅ | — | ✅ | — |
| Pengaturan (tulis) | ✅ | — | — | — |
| Manajemen User | ✅ | — | — | — |

---

## 6. Desain hemat kuota Firestore (paket gratis)

Kuota Spark dihitung **per read/write**, bukan per GB. Karena itu:

1. **Dokumen ringkasan** — dashboard/laporan membaca `ringkasan/*` (1 dokumen),
   bukan ribuan dokumen jemaat/transaksi.
2. **Delta update** — simpan/transaksi hanya menambah-minuskan angka ringkasan
   (`store.js → ubahRingkasanKeuangan`), bukan menghitung ulang semua data.
   Tombol **Hitung Ulang** di modul Keuangan tersedia bila data terasa tidak
   seimbang (perhitungan penuh, memakai kuota baca).
3. **Agregat `getCountFromServer`** — statistik & ringkasan jemaat dihitung
   dengan agregat (±1 read per query), bukan membaca dokumen.
4. **Pagination cursor** — tabel jemaat `orderBy("nama") + limit 25 + startAfter`.
5. **Filter satu field** — query `where` equality saja (tanpa indeks komposit),
   pencaringan/filter lain diselesaikan di browser atas data yang sudah dimuat.

---

## 7. Deploy ke GitHub Pages

```bash
git init
git add .
git commit -m "CMS Data Jemaat"
git branch -M main
git remote add origin https://github.com/<USERNAME>/<REPO>.git
git push -u origin main
```

1. Repo → **Settings → Pages**.
2. **Source**: Deploy from a branch · **Branch**: `main` / `/ (root)` → Save.
3. Tunggu 1–2 menit → buka `https://<USERNAME>.github.io/<REPO>/`.
4. Lalu isi **API key restriction** (§3.5) dengan domain itu.

Setelah online, jangan lupa menambahkan domain GitHub Pages ke aturan
Authentication kalau Anda mengaktifkan pembatasan domain di Firebase.

---

## 8. Modul Absensi (Google Sheets)

Menu **Absensi** berisi checklist kehadiran jemaat per sesi ibadah, diisi PIC.
Form hanya terbuka pada jendela waktu berikut (zona **WIB / Asia/Jakarta**):

| Sesi | Hari | Jam |
|---|---|---|
| Sabtu | Sabtu | 17.00–00.00 |
| IBR 1 | Minggu | 07.00–12.00 |
| IBR 2 | Minggu | 16.00–22.00 |

Di luar jendela itu form **terkunci** (tidak bisa diubah); perubahan data dilakukan
manual lewat spreadsheet. Hitung mundur sampai penutupan tampil di kartu atas,
dan jendela berikutnya ditampilkan bila sudah tertutup.

**Mode uji coba** — `MODE_UJI_COBA = true` di `js/sheets-config.js` menonaktifkan
jadwal sementara supaya absensi bisa dicoba kapan saja. Tabel jadwal tetap
menampilkan status aslinya (Terkunci/Dibuka), dan kartu atas menandainya dengan
🧪 *Mode uji coba*. Ubah kembali ke `false` untuk memakai jadwal asli.

### 8.1 Penyimpanan

Absen tidak disimpan di Firestore — **hanya diteruskan ke Google Sheets**.
Satu tab per bulan, dinamai `bulan + tahun` (mis. `November 2026`, `Desember 2026`),
dihitung dari tanggal sesi ibadah dalam WIB.

Satu baris per jemaat yang hadir. Tab bulan dibuat otomatis lewat
`addSheet` (bila belum ada) lengkap dengan baris judul kolomnya, lalu data
baru di-`append` ke bawah.

| Isi | Keterangan |
|---|---|
| `Tanggal` | `YYYY-MM-DD` (tanggal sesi, WIB) |
| `Sesi` | `Sabtu` / `IBR 1` / `IBR 2` |
| `Waktu` | jam kirim `HH:MM` (WIB) |
| `PIC` | nama user yang mengisi |
| `Nama`, `Wilayah`, `No. HP` | data jemaat |
| `Status` | `Hadir` |

### 8.2 Pengaturan koneksi Google Sheets

Semua sakelar ada di satu file: **`js/sheets-config.js`**.

| Konstanta | Isi |
|---|---|
| `SPREADSHEET_ID` | ID spreadsheet dari URL `docs.google.com/spreadsheets/d/<ID>/edit` |
| `SA_KEY_FILE` | nama berkas kunci service account (berdampingan dengan `index.html`) |
| `MODE_UJI_COBA` | `true` = jadwal dinonaktifkan untuk uji coba |

Prasyarat sekali waktu:

1. **Aktifkan Google Sheets API** di project service account:
   <https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1054004589803>
2. **Bagikan spreadsheet** ke email service account (`client_email` di berkas kunci)
   sebagai **Editor** — tanpa ini semua panggilan ditolak 403.
3. Isi `SPREADSHEET_ID`.

Cara kerja pengiriman: aplikasi menandatangani JWT RS256 dengan Web Crypto →
tukar token OAuth di `oauth2.googleapis.com/token` → cek/buat tab bulan →
`values:append`. Token dipakai ulang sampai hampir kedaluwarsa (±1 jam).

Bila `SPREADSHEET_ID` masih kosong, kiriman ditampung dulu di antrean lokal
peramban (`localStorage` → `cms_absen_antrean`, 20 kiriman terakhir) supaya
tidak hilang, dan aplikasi memberi tahu bahwa pengiriman belum aktif.

> ⚠️ **Keamanan**: berkas kunci berisi kunci privat, dan aplikasi ini berjalan
> di sisi klien — siapa pun yang membuka situsnya bisa membaca berkas itu.
> Jangan meng-commit/mendeploy folder ini ke repo atau halaman publik selama
> berkas kunci masih di dalamnya. Untuk produksi, teruskan pengiriman lewat
> server/proxy kecil agar kunci tidak pernah disajikan ke peramban.

### 8.3 Hosting statis (GitHub Pages) — proxy Vercel

GitHub Pages hanya menyajikan file mati, jadi berkas kunci **tidak boleh**
dan **tidak akan** ikut (`.gitignore` sudah menanganinya; memang 404 kalau
diminta lewat sana). Sebagai gantinya, `api/sheets.js` adalah Vercel
Function kecil (nol dependensi) yang menyimpan kunci di server.

| Environment variable Vercel | Isi |
|---|---|
| `SA_KEY_JSON` | seluruh isi berkas kunci `.json` service account (tempel apa adanya) |
| `SHEET_ID` | ID spreadsheet tujuan |

Langkah sekali waktu:

1. Buat akun Vercel (gratis, tanpa kartu kredit) lalu pasang CLI:
   `npm i -g vercel && vercel login`
2. Dari folder proyek: `vercel` (setup proyek) lalu `vercel --prod`.
3. Di Vercel: **Settings → Environment Variables** → isi `SA_KEY_JSON` dan
   `SHEET_ID`, lalu deploy ulang (`vercel --prod`) agar variabel terbaca.
4. Salin URL hasil deploy, mis. `https://absensi.vercel.app/api/sheets`,
   ke `SHEET_ENDPOINT` di `js/sheets-config.js` → commit → tunggu GitHub
   Pages memperbarui.

Dengan `SHEET_ENDPOINT` terisi, peramban hanya mengirim
`{sheet, header, rows}` ke proxy; kunci tidak pernah menyentuh peramban,
jadi penandatanganan JWT juga tidak lagi memerlukan Web Crypto di klien.
Dengan `SHEET_ENDPOINT` kosong (pemakaian lokal), jalur langsung §8.2 tetap
dipakai.

---

## 9. Pemecahan masalah

| Gejala | Penyebab / solusi |
|---|---|
| Halaman kosong putih | Dibuka lewat `file://` → jalankan server lokal (§1). Panel bantuan otomatis muncul menjelaskan ini. |
| "Akun Anda belum terdaftar" | Dokumen `users/{UID}` belum dibuat atau UID-nya salah → §3.4 |
| "Anda tidak punya akses ke data ini" | Firestore Rules belum dipublish atau belum cocok dengan role → §3.3 |
| Data tersimpan tapi ringkasan tidak berubah | Rule `ringkasan/*` menolak → cek §3.3, atau pakai tombol **Hitung Ulang** di Keuangan. |
| Nama tidak muncul di daftar ultah Dashboard | Jemaat belum punya `tanggalLahir`, atau data lama belum punya field turunan `ultahMD` → ubah & simpan ulang satu kali lewat form Data Jemaat. |
| Grafik kosong | CDN Chart.js gagal dimuat (koneksi) → muat ulang halaman. |
| "Gagal mengirim absensi. Cannot read properties of undefined (reading 'importKey')" | Laman dibuka lewat alamat **tidak aman** (`http://IP-jaringan`, nama host, `file://`) — Web Crypto diblokir peramban. Buka lewat `http://localhost:8123` atau pasang HTTPS. Kiriman tetap tersimpan di antrean lokal. |
| "Gagal mengirim absensi. Berkas kunci Google … (404)" | Situs di-hosting statis (GitHub Pages) — berkas kunci memang tidak ikut. Isi `SHEET_ENDPOINT` dengan URL proxy Vercel → §8.3. |

---

## 10. Ide tahap berikutnya

- **Ucapan ulang tahun otomatis** (GitHub Actions + Firebase Admin SDK):
  workflow harian membaca `jemaat` → filter ultah/anniversary hari ini →
  kirim pesan WhatsApp via **WhatsApp Cloud API** (butuh nomor bisnis Meta)
  atau Email. File workflow diletakkan di `.github/workflows/`.
- Ekspor PDF laporan bulanan, backup otomatis Firestore ke Cloud Storage.
