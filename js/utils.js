/* =========================================================
   utils.js — helper bersama semua modul
   (sanitasi XSS, format angka/tanggal, modal, toast)
   ========================================================= */

/** Simpan preferensi mata uang. */
export function setCurrency(code) {
  localStorage.setItem("cms_currency", code === "USD" ? "USD" : "IDR");
}
/** Mata uang aktif (IDR/USD), default IDR. */
export function getCurrency() {
  const v = localStorage.getItem("cms_currency");
  return v === "USD" ? "USD" : "IDR";
}

/** Ubah teks apa pun menjadi aman untuk disisipkan ke innerHTML (anti-XSS). */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format angka sesuai mata uang aktif: Rp 21.325.000 / $1,320.50 */
export function money(value, opts = {}) {
  const num = Number(value) || 0;
  const cur = opts.currency || getCurrency();
  const noSymbol = opts.noSymbol === true;
  try {
    return new Intl.NumberFormat(cur === "USD" ? "en-US" : "id-ID", {
      style: noSymbol ? "decimal" : "currency",
      currency: cur,
      maximumFractionDigits: noSymbol ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(num);
  } catch {
    return String(num);
  }
}

/** Angka polos tanpa simbol (untuk kolom nominal murni). */
export function num(value) {
  return money(value, { noSymbol: true });
}

/** Format angka persen satu desimal. */
export function percent(value) {
  return `${(Math.round((Number(value) || 0) * 10) / 10).toFixed(1)}%`;
}

/** Konversi berbagai bentuk tanggal (Timestamp/Date/string) → Date | null. */
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate(); // Firestore Timestamp
  if (value instanceof Date) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Format tanggal pendek: 22/10/2026 */
export function dateShort(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** Format tanggal panjang: 22 Oktober 2026 */
export function dateLong(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/** Format tanggal + jam: 22/10/2026 14:03 */
export function dateTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Tanggal lahir → "dd-MM" (untuk deteksi ulang tahun). */
export function dayMonth(value) {
  const d = toDate(value);
  if (!d) return "";
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Hitung umur (tahun) dari tanggal lahir. */
export function ageFrom(value) {
  const d = toDate(value);
  if (!d) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/** Teks input apa pun → hanya string polos (buang karakter kontrol). */
export function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

/** Angka dari input apa pun (koma/ titik dipisah), bila kosong → null. */
export function cleanNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  return isNaN(n) ? null : n;
}

/** Tanggal "yyyy-mm-dd" → Date (lokal, jam 12:00 aman dari geser zona). */
export function dateFromInput(value) {
  if (!value) return null;
  const [y, m, d] = String(value).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** Date → nilai input type="date" (yyyy-mm-dd). */
export function dateToInput(value) {
  const d = toDate(value);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------------- Toast ---------------- */
/** Notifikasi kecil di kanan bawah. type: success | error | (default) */
export function toast(message, type = "") {
  const wrap = document.getElementById("toast-wrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`.trim();
  el.textContent = String(message);
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

/* ---------------- Modal ---------------- */
let modalOnSubmit = null;

/** Buka modal. `bodyHTML` harus sudah lewat esc() untuk data dinamis. */
export function openModal(title, bodyHTML, onSubmit) {
  const backdrop = document.getElementById("modal-backdrop");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHTML;
  modalOnSubmit = typeof onSubmit === "function" ? onSubmit : null;
  backdrop.hidden = false;
  const first = backdrop.querySelector("input, select, textarea");
  if (first) setTimeout(() => first.focus(), 60);
}

/** Tutup modal dan bersihkan handler. */
export function closeModal() {
  const backdrop = document.getElementById("modal-backdrop");
  backdrop.hidden = true;
  document.getElementById("modal-body").innerHTML = "";
  modalOnSubmit = null;
}

/** Apakah modal sedang terbuka? */
export function isModalOpen() {
  const b = document.getElementById("modal-backdrop");
  return b && !b.hidden;
}

/** Ambil callback submit modal yang sedang aktif. */
export function getModalSubmit() {
  return modalOnSubmit;
}

/* ---------------- Dialog konfirmasi ---------------- */
/**
 * Konfirmasi aksi berbahaya (hapus dsb.).
 * Mengembalikan Promise<boolean>.
 */
export function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const okLabel = opts.okLabel || "Ya, lanjutkan";
    const cancelLabel = opts.cancelLabel || "Batal";
    const danger = opts.danger !== false;
    openModal(
      opts.title || "Konfirmasi",
      `<p style="margin:0;line-height:1.6">${esc(message)}</p>
       <div class="modal-foot">
         <button type="button" class="btn btn-outline" data-act="no">${esc(cancelLabel)}</button>
         <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="yes">${esc(okLabel)}</button>
       </div>`,
      null
    );
    const body = document.getElementById("modal-body");
    body.querySelector('[data-act="no"]').onclick = () => {
      closeModal();
      resolve(false);
    };
    body.querySelector('[data-act="yes"]').onclick = () => {
      closeModal();
      resolve(true);
    };
  });
}

/* ---------------- Penanganan error Firebase ---------------- */
/** Pesan error Firebase → kalimat Indonesia yang ramah. */
export function friendlyError(err) {
  const code = (err && err.code) || "";
  const map = {
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/wrong-password": "Kata sandi salah.",
    "auth/user-not-found": "Email belum terdaftar.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi beberapa saat lagi.",
    "auth/network-request-failed": "Gagal terhubung. Periksa koneksi internet Anda.",
    "auth/invalid-email": "Format email tidak valid.",
    "auth/weak-password": "Kata sandi minimal 6 karakter.",
    "auth/email-already-in-use": "Email sudah terdaftar.",
    "permission-denied": "Anda tidak punya akses ke data ini.",
    "unavailable": "Layanan Firebase belum terjangkau. Periksa koneksi.",
    "failed-precondition": "Operasi gagal dipenuhi. Muat ulang halaman lalu coba lagi.",
  };
  if (map[code]) return map[code];
  return (err && err.message) || "Terjadi kesalahan. Coba lagi.";
}
