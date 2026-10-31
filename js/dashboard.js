/* =========================================================
   dashboard.js — MODUL 1: Dashboard
   Kartu Profil Gereja & Tim Pengurus (diambil dari Pengaturan),
   4 kartu statistik, grafik Arus Kas, grafik donat Status Jemaat,
   serta tab Ulang Tahun / Anniversary / Aktivitas Terakhir.

   Sumber data (semua ringkas supaya hemat kuota Firestore):
     pengaturan/profil   → nama, logo, alamat, motto, struktur pengurus,
                           template pesan WhatsApp
     ringkasan/jemaat    → total, aktif, pasif
     ringkasan/kas_total → saldo + pemasukan/pengeluaran 12 bulan
     jemaat (terfilter)  → daftar ultah & anniversary bulan ini
     audit_log           → 10 aktivitas terakhir

   Catatan: daftar ultah/anniversary membaca field turunan
   `ultahMD` dan `annivMD` (format "MM-DD") yang ditulis oleh
   Modul Data Jemaat. Sebelum ada data jemaat, daftar tampil kosong.
   ========================================================= */

import { db } from "./firebase-config.js";
import {
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  limit,
  getCountFromServer,
} from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite } from "./auth.js";
import { esc, money, dateShort, dateLong, ageFrom, toDate } from "./utils.js";

/* ---------------- Sumber data ---------------- */

/** Ambil dokumen pengaturan/profil; null bila belum pernah diisi. */
async function ambilProfil() {
  const snap = await getDoc(doc(db, "pengaturan", "profil"));
  return snap.exists() ? snap.data() : null;
}

/**
 * Statistik jemaat. Utamanya dari `ringkasan/jemaat`;
 * bila belum ada, hitung pakai agregat (getCountFromServer)
 * yang tetap murah — bukan membaca ribuan dokumen.
 */
async function ambilStatistik() {
  const snap = await getDoc(doc(db, "ringkasan", "jemaat"));
  if (snap.exists()) {
    const d = snap.data();
    return {
      total: d.total || 0,
      aktif: d.aktif || 0,
      pasif: d.pasif || 0,
      sumber: "ringkasan",
    };
  }
  const semua = collection(db, "jemaat");
  const total = (await getCountFromServer(semua)).data().count;
  const aktif = (
    await getCountFromServer(query(semua, where("status", "==", "Aktif")))
  ).data().count;
  return { total, aktif, pasif: Math.max(total - aktif, 0), sumber: "agregat" };
}

/** Saldo & arus kas 12 bulan terakhir dari `ringkasan/kas_total`. */
async function ambilKeuangan() {
  const snap = await getDoc(doc(db, "ringkasan", "kas_total"));
  if (!snap.exists()) return { pemasukan: 0, pengeluaran: 0, saldo: 0, perBulan: {} };
  const d = snap.data();
  return {
    pemasukan: d.pemasukan || 0,
    pengeluaran: d.pengeluaran || 0,
    saldo: d.saldo || 0,
    perBulan: d.perBulan || {},
  };
}

/** Rentang "MM-DD" bulan berjalan, untuk query jangkauan string. */
function rentangBulanIni() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const hariTerakhir = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    mulai: `${mm}-01`,
    akhir: `${mm}-${String(hariTerakhir).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(now),
  };
}

/** Daftar jemaat yang berulang tahun / anniversary bulan ini. */
async function ambilPerayaan(bulan) {
  const kol = collection(db, "jemaat");
  const q = query(
    kol,
    where("ultahMD", ">=", bulan.mulai),
    where("ultahMD", "<=", bulan.akhir),
    orderBy("ultahMD"),
    limit(100)
  );
  const q2 = query(
    kol,
    where("annivMD", ">=", bulan.mulai),
    where("annivMD", "<=", bulan.akhir),
    orderBy("annivMD"),
    limit(100)
  );
  const [ultah, anniv] = await Promise.all([getDocs(q), getDocs(q2)]);
  const baca = (snap) =>
    snap.docs.map((d) => {
      const v = d.data();
      return { id: d.id, ...v };
    });
  return { ultah: baca(ultah), anniv: baca(anniv) };
}

/** 10 aktivitas terakhir dari audit log. */
async function ambilAktivitas() {
  const q = query(collection(db, "audit_log"), orderBy("waktu", "desc"), limit(10));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Muat seluruh data dashboard sekaligus. */
async function muatSemua() {
  const bulan = rentangBulanIni();
  const [profil, statistik, keuangan, perayaan, aktivitas] = await Promise.all([
    ambilProfil(),
    ambilStatistik(),
    ambilKeuangan(),
    ambilPerayaan(bulan),
    ambilAktivitas(),
  ]);
  return { profil, statistik, keuangan, perayaan, aktivitas, bulan };
}

/* ---------------- Potongan tampilan ---------------- */

/** Baris nama + nilai untuk kartu profil / pengurus. */
function barisNama(label, nilai) {
  const isi = nilai ? esc(nilai) : '<span class="muted">belum diisi</span>';
  return `<div class="person-row"><span class="muted">${esc(label)}</span><b>${isi}</b></div>`;
}

function kartuProfil(profil) {
  const admin = canWrite("pengaturan");
  const tombol = admin
    ? `<button class="btn btn-outline btn-sm" data-goto="profil">⚙️ Ubah di Pengaturan</button>`
    : "";
  const logo =
    profil && profil.logoUrl
      ? `<img class="profil-logo" src="${esc(profil.logoUrl)}" alt="Logo gereja"
           onerror="this.style.display='none'">`
      : `<div class="profil-logo profil-logo-kosong">⛪</div>`;
  const nama = profil && profil.namaGereja ? esc(profil.namaGereja) : "Belum diatur";
  const alamat =
    profil && profil.alamat ? esc(profil.alamat) : '<span class="muted">alamat belum diisi</span>';
  const motto =
    profil && profil.deskripsi ? `<p class="profil-motto">${esc(profil.deskripsi)}</p>` : "";

  return `
    <div class="card">
      <div class="row row-between">
        <div class="card-title">${t("dash.profile")}</div>
        ${tombol}
      </div>
      <div class="profil-row">
        ${logo}
        <div class="profil-teks">
          <h3>${nama}</h3>
          <p>${alamat}</p>
          ${motto}
        </div>
      </div>
    </div>`;
}

function kartuPengurus(profil) {
  const s = (profil && profil.struktur) || {};
  const admin = canWrite("pengaturan");
  const tombol = admin
    ? `<button class="btn btn-outline btn-sm" data-goto="struktur">⚙️ Ubah di Pengaturan</button>`
    : "";
  return `
    <div class="card">
      <div class="row row-between">
        <div class="card-title">${t("dash.committee")}</div>
        ${tombol}
      </div>
      <p class="card-sub">Struktur organisasi gereja</p>
      ${barisNama("Gembala", s.gembala)}
      ${barisNama("Ketua Majelis", s.ketuaMajelis)}
      ${barisNama("Bendahara", s.bendahara)}
    </div>`;
}

/** Kartu statistik kecil (ikon + label + angka). */
function kartuStatistik(ico, label, nilai, sub) {
  return `
    <div class="card stat-card">
      <div class="stat-ico">${ico}</div>
      <div class="stat-teks">
        <span class="stat-label">${esc(label)}</span>
        <b class="stat-value">${nilai}</b>
        <small class="stat-sub">${sub}</small>
      </div>
    </div>`;
}

function daftarPerayaan(jenis, items, profil) {
  if (!items.length) {
    return `<div class="empty-state"><span class="empty-ico">🎉</span>
      <b>${jenis === "ultah" ? t("dash.noBirthdays") : t("dash.noAnniv")}</b>
      <span>${t("dash.emptyHint")}</span></div>`;
  }
  const template =
    (jenis === "ultah" && profil && profil.templateUlangTahun) ||
    (jenis === "anniv" && profil && profil.templateAnniversary) ||
    "";
  const baris = items.map((it) => {
    const nama = it.nama || "(tanpa nama)";
    const tgl = jenis === "ultah" ? it.tanggalLahir : it.tanggalNikah;
    const umur =
      jenis === "ultah"
        ? ageFrom(it.tanggalLahir)
        : tahunSejak(it.tanggalNikah);
    const pesan = String(template || t("dash.waDefault"))
      .split("[NAMA]")
      .join(nama);
    const href = tautanWa(it.noHp, pesan);
    const info =
      jenis === "ultah"
        ? `${dateLong(tgl)}${umur !== null ? ` · ${umur} Thn` : ""}`
        : `${dateLong(tgl)}${umur ? ` · ${umur} Thn menikah` : ""}`;
    return `
      <div class="list-item">
        <div>
          <div class="list-name">${esc(nama)}</div>
          <div class="list-meta">${info}</div>
        </div>
        <a class="btn btn-success btn-sm" href="${href}" target="_blank" rel="noopener">
          💬 ${t("dash.greet")}
        </a>
      </div>`;
  });
  return `<div class="list-wrap">${baris.join("")}</div>`;
}

/** Lama menikah dalam tahun, bila tanggal nikah terisi. */
function tahunSejak(value) {
  const d = toDate(value);
  if (!d) return null;
  const now = new Date();
  let th = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) th--;
  return th > 0 ? th : null;
}

/** Susun tautan wa.me; nomor Indonesia diseragamkan jadi kode 62. */
function tautanWa(noHp, pesan) {
  const teks = encodeURIComponent(pesan);
  let n = String(noHp || "").replace(/\D/g, "");
  if (!n) return `https://wa.me/?text=${teks}`;
  if (n.startsWith("0")) n = "62" + n.slice(1);
  else if (n.startsWith("8")) n = "62" + n;
  return `https://wa.me/${n}?text=${teks}`;
}

function daftarAktivitas(items) {
  if (!items.length) {
    return `<div class="empty-state"><span class="empty-ico">🗂️</span>
      <b>${t("dash.noActivity")}</b><span>Perubahan data akan tercatat di sini.</span></div>`;
  }
  const ikon = { tambah: "➕", edit: "✏️", hapus: "🗑️" };
  return `<div class="list-wrap">${items
    .map((a) => {
      const siapa = a.userName || a.userId || "Pengguna";
      const aksi = a.aksi || "ubah";
      const detail = a.detail ? `<span class="list-meta"> — ${esc(a.detail)}</span>` : "";
      return `<div class="list-item">
        <div>
          <div class="list-name">${ikon[aksi] || "•"} ${esc(siapa)} ${esc(aksi)} data ${esc(
            a.koleksi || ""
          )}</div>
          <div class="list-meta">${esc(a.docId || "")}${detail}</div>
        </div>
        <div class="list-meta">${dateShort(a.waktu)}</div>
      </div>`;
    })
    .join("")}</div>`;
}

/* ---------------- Grafik ---------------- */

let grafik = [];

/** Hancurkan grafik lama agar tidak menumpuk saat pindah menu. */
function hancurkanGrafik() {
  grafik.forEach((c) => {
    try {
      c.destroy();
    } catch (e) {
      /* grafik sudah tidak ada */
    }
  });
  grafik = [];
}

/** Label 12 bulan terakhir, contoh: "Nov", "Des", … */
function label12Bulan() {
  const labels = [];
  const kunci = [];
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("id-ID", { month: "short" });
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(fmt.format(d));
    kunci.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return { labels, kunci };
}

function buatGrafik(keuangan, statistik) {
  if (typeof window.Chart === "undefined") return; // CDN Chart.js belum termuat

  const { labels, kunci } = label12Bulan();
  const masuk = kunci.map((k) => (keuangan.perBulan[k] && keuangan.perBulan[k].masuk) || 0);
  const keluar = kunci.map((k) => (keuangan.perBulan[k] && keuangan.perBulan[k].keluar) || 0);

  const elKas = document.getElementById("chart-arus-kas");
  if (elKas) {
    grafik.push(
      new Chart(elKas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Pemasukan",
              data: masuk,
              borderColor: "#16a34a",
              backgroundColor: "rgba(22,163,74,.12)",
              fill: true,
              tension: 0.35,
              pointRadius: 3,
            },
            {
              label: "Pengeluaran",
              data: keluar,
              borderColor: "#dc2626",
              backgroundColor: "rgba(220,38,38,.10)",
              fill: true,
              tension: 0.35,
              pointRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom" },
            tooltip: {
              callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: (v) => money(v) },
            },
          },
        },
      })
    );
  }

  const elStatus = document.getElementById("chart-status-jemaat");
  if (elStatus) {
    grafik.push(
      new Chart(elStatus, {
        type: "doughnut",
        data: {
          labels: [t("common.active"), t("common.inactive")],
          datasets: [
            {
              data: [statistik.aktif, statistik.pasif],
              backgroundColor: ["#16a34a", "#cbd5e1"],
              borderWidth: 2,
              borderColor: "#fff",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "66%",
          plugins: { legend: { position: "bottom" } },
        },
      })
    );
  }
}

/* ---------------- Render ---------------- */

function kartuStatistikHtml(stat, keuangan, perayaan, bulan) {
  return `
    <div class="grid grid-4 mb">
      ${kartuStatistik("👥", t("dash.totalMembers"), stat.total, `${stat.aktif} aktif · ${stat.pasif} pasif`)}
      ${kartuStatistik(
        "💰",
        t("dash.totalCash"),
        money(keuangan.saldo),
        `${money(keuangan.pemasukan)} masuk · ${money(keuangan.pengeluaran)} keluar`
      )}
      ${kartuStatistik("🎂", t("dash.birthdayMonth"), perayaan.ultah.length, esc(bulan.label))}
      ${kartuStatistik("💍", t("dash.annivMonth"), perayaan.anniv.length, esc(bulan.label))}
    </div>`;
}

function render(data) {
  const { profil, statistik, keuangan, perayaan, aktivitas, bulan } = data;

  return `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("dash.subtitle")}</p>
      <button class="btn btn-outline" id="dash-refresh">🔄 ${t("action.refresh")}</button>
    </div>

    <div class="grid grid-2 mb">
      ${kartuProfil(profil)}
      ${kartuPengurus(profil)}
    </div>

    ${kartuStatistikHtml(statistik, keuangan, perayaan, bulan)}

    <div class="grid grid-2 mb">
      <div class="card">
        <div class="card-title">${t("dash.cashflow")} <span class="muted">— 12 bulan terakhir</span></div>
        <p class="card-sub">Pemasukan vs pengeluaran seluruh proyek kas</p>
        <div class="chart-box"><canvas id="chart-arus-kas"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">${t("dash.memberStatus")}</div>
        <p class="card-sub">Perbandingan jemaat aktif dan pasif</p>
        <div class="chart-box"><canvas id="chart-status-jemaat"></canvas></div>
      </div>
    </div>

    <div class="card">
      <div class="tabs" id="dash-tabs">
        <button class="tab-btn active" data-tab="ultah">🎂 ${t("dash.tabBirthdays")}</button>
        <button class="tab-btn" data-tab="anniv">💍 ${t("dash.tabAnniv")}</button>
        <button class="tab-btn" data-tab="aktivitas">🕘 ${t("dash.tabActivity")}</button>
      </div>

      <div class="tab-panel" data-panel="ultah">
        <p class="muted">Berulang tahun di ${esc(bulan.label)}</p>
        ${daftarPerayaan("ultah", perayaan.ultah, profil)}
      </div>

      <div class="tab-panel" data-panel="anniv" hidden>
        <p class="muted">Merayakan anniversary pernikahan di ${esc(bulan.label)}</p>
        ${daftarPerayaan("anniv", perayaan.anniv, profil)}
      </div>

      <div class="tab-panel" data-panel="aktivitas" hidden>
        ${daftarAktivitas(aktivitas)}
      </div>
    </div>`;
}

/** Ganti isi tab tanpa memuat ulang seluruh modul. */
function pilihTab(container, nama) {
  container.querySelectorAll("#dash-tabs .tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === nama);
  });
  container.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.panel !== nama;
  });
}

/* ---------------- Modul ---------------- */

const dashboard = {
  key: "dashboard",

  async mount(el) {
    hancurkanGrafik();
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;

    let data;
    data = await muatSemua();
    el.innerHTML = render(data);

    // Ganti isi agar tombol/tabs bisa dipakai ulang setiap mount
    el.querySelector("#dash-refresh").addEventListener("click", () => this.mount(el));

    el.querySelector("#dash-tabs").addEventListener("click", (e) => {
      const b = e.target.closest(".tab-btn");
      if (b) pilihTab(el, b.dataset.tab);
    });

    el.querySelectorAll("[data-goto]").forEach((b) => {
      b.addEventListener("click", () => {
        // Buka menu Pengaturan langsung di tab yang sesuai
        document.dispatchEvent(
          new CustomEvent("cms:open-pengaturan", { detail: { tab: b.dataset.goto } })
        );
      });
    });

    buatGrafik(data.keuangan, data.statistik);
  },

  unmount() {
    hancurkanGrafik();
  },
};

export default dashboard;
