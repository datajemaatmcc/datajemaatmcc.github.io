/* =========================================================
   app.js — kontroler utama aplikasi
   Menangani: status login, navigasi antar modul, header
   (bahasa, mata uang, nama akun, indikator koneksi), sidebar
   responsif, modal, dan pemuatan awal data gereja.
   ========================================================= */

import { IS_CONFIG_READY, db } from "./firebase-config.js";
import { doc, onSnapshot } from "firebase/firestore";
import {
  watchAuth,
  login,
  logout,
  currentUser,
  canRead,
  loginErrorText,
  PERMISSIONS,
} from "./auth.js";
import { t, getLang, setLang, applyI18n } from "./i18n.js";
import {
  getCurrency,
  setCurrency,
  toast,
  closeModal,
  getModalSubmit,
  esc,
} from "./utils.js";

import dashboard from "./dashboard.js";
import jemaat from "./jemaat.js";
import keuangan from "./keuangan.js";
import logistik from "./logistik.js";
import absensi from "./absensi.js";
import laporan from "./laporan.js";
import pengaturan from "./pengaturan.js";

/** Daftar modul sesuai urutan menu. */
const MODULES = { dashboard, jemaat, keuangan, logistik, absensi, laporan, pengaturan };
const ORDER = ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"];

let activeView = "dashboard";
/** Modul yang sedang merender, untuk dipanggil unmount() saat berpindah. */
let mountedModule = null;
/** Sudahkah status login pertama kali diterima dari Firebase? */
let authResolved = false;

const $ = (sel) => document.querySelector(sel);

/* =========================================================
   NAVIGASI MODUL
   ========================================================= */
function navigate(viewKey) {
  if (!MODULES[viewKey]) return;

  // Batas peran: modul yang tidak boleh dibaca tidak dibuka.
  if (!canRead(viewKey)) {
    toast("Peran Anda tidak memiliki akses ke menu ini.", "error");
    return;
  }

  // Lepas modul sebelumnya (bersihkan grafik/langganan).
  if (mountedModule && typeof mountedModule.unmount === "function") {
    try {
      mountedModule.unmount();
    } catch (e) {
      console.warn("unmount gagal:", e);
    }
  }
  mountedModule = null;

  activeView = viewKey;

  // Tampilkan section terpilih, sembunyikan yang lain.
  ORDER.forEach((key) => {
    const el = document.getElementById(`view-${key}`);
    if (el) el.hidden = key !== viewKey;
  });

  // Highlight menu aktif + judul halaman.
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewKey);
  });
  $("#page-title").textContent = t(`title.${viewKey}`);

  // Render isi modul.
  const mod = MODULES[viewKey];
  const container = document.getElementById(`view-${viewKey}`);
  mountedModule = mod;
  Promise.resolve(mod.mount(container)).catch((err) => {
    console.error(`Gagal merender modul ${viewKey}:`, err);
    container.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⚠️</span>
      <b>Gagal memuat modul</b>
      <span>${esc(err && err.message ? err.message : err)}</span>
    </div></div>`;
  });

  // Tutup sidebar bila dibuka dari menu di layar kecil.
  closeSidebar();
}

/* =========================================================
   SIDEBAR RESPONSIF
   ========================================================= */
function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebar-overlay").hidden = false;
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-overlay").hidden = true;
}

/* =========================================================
   INDIKATOR KONFLOSI FIREBASE
   ========================================================= */
let unsubSettings = null;

function setConn(state, label) {
  const dot = $("#conn-dot");
  const txt = $("#conn-text");
  dot.classList.toggle("online", state === "on");
  dot.classList.toggle("offline", state === "off");
  txt.textContent = label;
}

/**
 * Langganan langsung ke dokumen pengaturan/profil.
 * Snapshot sukses = koneksi sehat; dokumen juga sumber nama & logo gereja
 * untuk sidebar, jadi tidak perlu baca terpisah.
 */
function watchConnection() {
  if (unsubSettings) {
    unsubSettings();
    unsubSettings = null;
  }
  if (!IS_CONFIG_READY) {
    setConn("off", "Konfigurasi belum diisi");
    return;
  }
  setConn("on", t("common.connected"));

  unsubSettings = onSnapshot(
    doc(db, "pengaturan", "profil"),
    (snap) => {
      setConn("on", t("common.connected"));
      if (snap.exists()) applyChurchProfile(snap.data());
    },
    (err) => {
      console.warn("Snapshot pengaturan gagal:", err);
      setConn("off", t("common.disconnected"));
    }
  );
}

/** Terapkan nama & logo gereja ke sidebar dan halaman login. */
function applyChurchProfile(data) {
  const nama = data && data.namaGereja ? String(data.namaGereja) : "Gereja";
  $("#sidebar-church-name").textContent = nama;
  $("#login-church-name").textContent = nama;
  document.title = `${nama} — CMS Data Jemaat`;

  const logo = $("#sidebar-logo");
  if (data && data.logoUrl) {
    logo.src = String(data.logoUrl);
    logo.hidden = false;
    logo.onerror = () => {
      logo.hidden = true; // URL logo rusak → sembunyikan, jangan pecahkan tampilan
    };
  } else {
    logo.hidden = true;
    logo.removeAttribute("src");
  }
}

/* =========================================================
   HEADER: USER, BAHASA, MATA UANG, KELUAR
   ========================================================= */
function renderUser() {
  const u = currentUser;
  $("#user-name").textContent = u ? u.nama || u.email || "Pengguna" : "—";
  $("#user-email").textContent = u ? u.email || "" : "";
  $("#user-avatar").textContent = u
    ? (u.nama || u.email || "U").trim().charAt(0).toUpperCase()
    : "U";
  $("#sidebar-user-role").textContent = u ? u.role || "Viewer" : "—";
}

function renderLangCurrency() {
  $("#sel-lang").value = getLang();
  $("#sel-currency").value = getCurrency();
}

function onLangChange(e) {
  setLang(e.target.value);
  applyI18n();
  // Judul & isi modul ikut bahasa baru.
  $("#page-title").textContent = t(`title.${activeView}`);
  if (unsubSettings) setConn("on", t("common.connected"));
  if (mountedModule && typeof mountedModule.mount === "function") {
    const el = document.getElementById(`view-${activeView}`);
    mountedModule.mount(el);
  }
}

function onCurrencyChange(e) {
  setCurrency(e.target.value);
  // Muat ulang modul aktif agar format angka ikut berubah.
  if (mountedModule && typeof mountedModule.mount === "function") {
    const el = document.getElementById(`view-${activeView}`);
    mountedModule.mount(el);
  }
  toast(`Mata uang: ${getCurrency()}`);
}

/* =========================================================
   TAMPILAN LOGIN vs APLIKASI
   ========================================================= */
function showLogin() {
  hideSplash();
  $("#view-login").hidden = false;
  $("#app-shell").hidden = true;
  $("#config-warning").hidden = IS_CONFIG_READY;
  $("#login-form").hidden = !IS_CONFIG_READY;
}

/** Sembunyikan layar pemuatan (dipanggil saat tampilan siap). */
function hideSplash() {
  const s = document.getElementById("boot-splash");
  if (s) s.hidden = true;
}

function showApp() {
  hideSplash();
  $("#view-login").hidden = true;
  $("#app-shell").hidden = false;
  renderUser();
  renderLangCurrency();
  applyI18n();
  watchConnection();
  navigate("dashboard");
}

/* =========================================================
   MODAL (delegasi event global)
   ========================================================= */
function wireModal() {
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("mousedown", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSidebar();
  });
  // Submit baku form di dalam modal → teruskan ke handler modul.
  $("#modal-body").addEventListener("submit", (e) => {
    e.preventDefault();
    const handler = getModalSubmit();
    if (handler) handler(new FormData(e.target), e.target);
  });
}

/* =========================================================
   INISIALISASI
   ========================================================= */
function wireLogin() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#login-btn");
    const errEl = $("#login-error");
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = "Memproses…";
    try {
      await login($("#login-email").value.trim(), $("#login-password").value);
      // watchAuth akan memanggil showApp() otomatis.
    } catch (err) {
      errEl.innerHTML = loginErrorText(err);
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Masuk";
    }
  });
}

function wireHeader() {
  $("#btn-hamburger").addEventListener("click", () => {
    const open = $("#sidebar").classList.contains("open");
    open ? closeSidebar() : openSidebar();
  });
  $("#sidebar-overlay").addEventListener("click", closeSidebar);

  $("#sel-lang").addEventListener("change", onLangChange);
  $("#sel-currency").addEventListener("change", onCurrencyChange);

  $("#btn-logout").addEventListener("click", async () => {
    await logout();
    toast("Anda telah keluar.");
    showLogin();
  });
}

/** Permintaan modul lain (mis. tombol "Ubah di Pengaturan") untuk membuka
 *  menu Pengaturan pada tab tertentu. */
function wireOpenSettings() {
  document.addEventListener("cms:open-pengaturan", (e) => {
    navigate("pengaturan");
    const tab = e.detail && e.detail.tab;
    const mod = MODULES.pengaturan;
    if (tab && mod && typeof mod.openTab === "function") mod.openTab(tab);
  });
}

function wireNav() {
  $("#sidebar-nav").addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;
    e.preventDefault();
    navigate(item.dataset.view);
  });
}

function boot() {
  // Penanda untuk jaring pengaman di index.html: aplikasi berhasil jalan.
  window.__CMS_BOOTED = true;

  document.documentElement.lang = getLang();
  renderLangCurrency();
  wireLogin();
  wireHeader();
  wireNav();
  wireOpenSettings();
  wireModal();

  // Pantau sesi login selama aplikasi berjalan.
  watchAuth((user) => {
    authResolved = true;
    if (user) showApp();
    else showLogin();
  });

  // Jaring pengaman: bila status login tak kunjung datang (internet lambat/putus),
  // jangan biarkan layar pemuatan menggantung — tampilkan halaman login + pemberitahuan.
  setTimeout(() => {
    if (authResolved) return;
    hideSplash();
    showLogin();
    toast(
      "Koneksi ke Firebase belum merespons. Periksa internet Anda lalu muat ulang halaman.",
      "error"
    );
  }, 10000);
}

boot();

// Ekspor kecil untuk dipakai modul lain bila perlu.
export { navigate, currentUser, PERMISSIONS };
