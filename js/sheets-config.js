/* =========================================================
   sheets-config.js — satu-satunya tempat pengaturan absensi
   yang sering Anda ubah. Isi/tulis di sini saja.

   1. SPREADSHEET_ID : ID spreadsheet tujuan.
      Ambil dari URL: https://docs.google.com/spreadsheets/d/<ID>/edit
   2. SA_KEY_FILE    : berkas kunci service account (di folder
      yang sama dengan index.html).
   3. MODE_UJI_COBA  : true = jadwal dinonaktifkan, form absensi
      selalu terbuka supaya bisa dicoba kapan saja.
      Kembalikan ke false untuk memakai jadwal asli
      (Sabtu 17.00–00.00, IBR 1 07.00–12.00, IBR 2 16.00–22.00 WIB).
   ========================================================= */

/** ID spreadsheet tujuan absensi (kosongkan bila belum tahu). */
export const SPREADSHEET_ID = "1FoasHOedhv2-AkBeZiulTPDbuyZtJVxPiULmX6L_tHw";

/** Berkas kunci service account Google (jangan di-commit ke repo publik). */
export const SA_KEY_FILE = "absensimcc-b37020212fb4.json";

/** true = jadwal dinonaktifkan untuk uji coba. */
export const MODE_UJI_COBA = true;

/**
 * URL endpoint proxy (Vercel Function `api/sheets.js`) yang menyimpan
 * kunci service account di server. Isi SETELAH deploy (README §8.3):
 *   https://<proyek-anda>.vercel.app/api/sheets
 * Biarkan kosong ("") bila berjalan lokal dengan berkas kunci langsung.
 */
export const SHEET_ENDPOINT = "https://absensi-jemaat-bice.vercel.app/api/sheets";
