/* =========================================================
   laporan.js — MODUL 5: Laporan & Analitik
   Kartu ringkasan periode, 4 grafik analitik, ekspor CSV,
   dan cetak laporan.

   Sumber data (hemat kuota):
     ringkasan/kas_total  → pemasukan/pengeluaran/saldo per bulan
     ringkasan/jemaat     → perWilayah, perUmur, total/aktif/pasif
     transaksi (limit 300)→ donat pengeluaran per kategori
     aset (limit 500)     → nilai inventaris
   ========================================================= */

import { db } from "./firebase-config.js";
import { collection, getDocs, query, orderBy, limit, getDoc, doc } from "firebase/firestore";
import { t } from "./i18n.js";
import { esc, money, num, dateShort, toast, friendlyError, toDate } from "./utils.js";
import { unduhCSV } from "./store.js";

const state = {
  periode: "12", // bulan | 3 | 12 | all
  kas: { pemasukan: 0, pengeluaran: 0, saldo: 0, perBulan: {} },
  jemaat: null,
  transaksi: [],
  nilaiAset: 0,
  jumlahAset: 0,
  terpotong: false,
};

let el = null;
let charts = [];

const PALET = ["#16233f", "#2563eb", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#84cc16", "#ec4899"];

/* ---------------- Periode ---------------- */

function batasPeriode() {
  const now = new Date();
  switch (state.periode) {
    case "bulan":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "3":
      return new Date(now.getFullYear(), now.getMonth() - 2, 1);
    case "12":
      return new Date(now.getFullYear(), now.getMonth() - 11, 1);
    default:
      return null;
  }
}

function labelPeriode() {
  const map = {
    bulan: t("keu.periodMonth"),
    "3": t("keu.period3"),
    "12": t("keu.period12"),
    all: t("keu.periodAll"),
  };
  return map[state.periode] || "";
}

/** Daftar kunci bulan "YYYY-MM" dalam periode terpilih. */
function kunciPeriode() {
  const batas = batasPeriode();
  const now = new Date();
  const daftar = [];
  const mulai = batas || new Date(now.getFullYear() - 5, 0, 1);
  const c = new Date(mulai.getFullYear(), mulai.getMonth(), 1);
  while (c <= now) {
    daftar.push(`${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}`);
    c.setMonth(c.getMonth() + 1);
  }
  return daftar;
}

function dalamPeriode(tanggal) {
  const batas = batasPeriode();
  if (!batas) return true;
  const d = toDate(tanggal);
  return d ? d >= batas : true;
}

/* ---------------- Sumber data ---------------- */

async function muatSemua() {
  const [snapKas, snapJemaat, snapTransaksi, snapAset] = await Promise.all([
    getDoc(doc(db, "ringkasan", "kas_total")),
    getDoc(doc(db, "ringkasan", "jemaat")),
    getDocs(query(collection(db, "transaksi"), orderBy("tanggal", "desc"), limit(300))),
    getDocs(query(collection(db, "aset"), limit(500))),
  ]);

  state.kas = snapKas.exists()
    ? {
        pemasukan: snapKas.data().pemasukan || 0,
        pengeluaran: snapKas.data().pengeluaran || 0,
        saldo: snapKas.data().saldo || 0,
        perBulan: snapKas.data().perBulan || {},
      }
    : { pemasukan: 0, pengeluaran: 0, saldo: 0, perBulan: {} };

  state.jemaat = snapJemaat.exists() ? snapJemaat.data() : null;

  state.transaksi = snapTransaksi.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.terpotong = snapTransaksi.docs.length === 300;

  const aset = snapAset.docs.map((d) => d.data());
  state.jumlahAset = aset.length;
  state.nilaiAset = aset.reduce(
    (s, r) => s + (Number(r.jumlah) || 0) * (Number(r.hargaSatuan) || 0),
    0
  );
}

function ringkasPeriode() {
  const kunci = new Set(kunciPeriode());
  let pemasukan = 0;
  let pengeluaran = 0;
  Object.keys(state.kas.perBulan).forEach((k) => {
    if (!kunci.has(k)) return;
    pemasukan += Number(state.kas.perBulan[k].masuk) || 0;
    pengeluaran += Number(state.kas.perBulan[k].keluar) || 0;
  });
  return { pemasukan, pengeluaran, saldo: pemasukan - pengeluaran };
}

/* ---------------- Grafik ---------------- */

function hancurkanGrafik() {
  charts.forEach((c) => {
    try {
      c.destroy();
    } catch {
      /* grafik sudah dilepas */
    }
  });
  charts = [];
}

function buatGrafik() {
  if (typeof window.Chart === "undefined") return;
  const kunci = kunciPeriode();

  // 1. Pengeluaran per kategori (donat)
  const perKategori = {};
  state.transaksi
    .filter((r) => r.jenis === "keluar" && dalamPeriode(r.tanggal))
    .forEach((r) => {
      const k = r.kategori || t("laporan.uncategorized");
      perKategori[k] = (perKategori[k] || 0) + (Number(r.nominal) || 0);
    });
  const elK = document.getElementById("rep-donat-kategori");
  if (elK) {
    const labels = Object.keys(perKategori);
    charts.push(
      new Chart(elK, {
        type: "doughnut",
        data: {
          labels: labels.length ? labels : [t("laporan.noData")],
          datasets: [
            {
              data: labels.length ? Object.values(perKategori) : [1],
              backgroundColor: labels.length ? PALET : ["#e5e7eb"],
            },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      })
    );
  }

  // 2. Pemasukan vs pengeluaran per bulan (batang)
  const elB = document.getElementById("rep-bar-bulan");
  if (elB) {
    const masuk = [];
    const keluar = [];
    kunci.forEach((k) => {
      const v = state.kas.perBulan[k] || {};
      masuk.push(Number(v.masuk) || 0);
      keluar.push(Number(v.keluar) || 0);
    });
    charts.push(
      new Chart(elB, {
        type: "bar",
        data: {
          labels: kunci,
          datasets: [
            { label: t("keu.income"), data: masuk, backgroundColor: "#22c55e" },
            { label: t("keu.expense"), data: keluar, backgroundColor: "#ef4444" },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: "bottom" } },
          scales: { y: { ticks: { callback: (v) => money(v, { noSymbol: true }) } } },
        },
      })
    );
  }

  // 3. Jemaat per wilayah (donat)
  const elW = document.getElementById("rep-donat-wilayah");
  if (elW) {
    const pw = (state.jemaat && state.jemaat.perWilayah) || {};
    const labels = Object.keys(pw).filter((k) => pw[k] > 0);
    charts.push(
      new Chart(elW, {
        type: "doughnut",
        data: {
          labels: labels.length ? labels : [t("laporan.noData")],
          datasets: [
            { data: labels.length ? labels.map((k) => pw[k]) : [1], backgroundColor: labels.length ? PALET : ["#e5e7eb"] },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      })
    );
  }

  // 4. Jemaat per kategori umur (batang)
  const elU = document.getElementById("rep-bar-umur");
  if (elU) {
    const pu = (state.jemaat && state.jemaat.perUmur) || {};
    const labels = ["Anak", "Remaja", "Pemuda", "Dewasa", "Lansia"];
    charts.push(
      new Chart(elU, {
        type: "bar",
        data: {
          labels,
          datasets: [{ label: t("title.jemaat"), data: labels.map((l) => Number(pu[l]) || 0), backgroundColor: "#2563eb" }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { ticks: { precision: 0 } } },
        },
      })
    );
  }
}

/* ---------------- Tampilan ---------------- */

function kartu(ico, label, nilai, sub) {
  return `
    <div class="card stat-card">
      <div class="stat-ico">${ico}</div>
      <div class="stat-teks">
        <span class="stat-label">${esc(label)}</span>
        <b class="stat-value">${esc(nilai)}</b>
        <small class="stat-sub">${sub}</small>
      </div>
    </div>`;
}

function gambar() {
  hancurkanGrafik();
  const r = ringkasPeriode();
  const j = state.jemaat || {};

  const opsiPeriode = [
    ["bulan", t("keu.periodMonth")],
    ["3", t("keu.period3")],
    ["12", t("keu.period12")],
    ["all", t("keu.periodAll")],
  ]
    .map(([v, l]) => `<option value="${v}" ${state.periode === v ? "selected" : ""}>${esc(l)}</option>`)
    .join("");

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("rep.subtitle")} — <b>${esc(labelPeriode())}</b></p>
      <div class="row">
        <button class="btn btn-outline btn-sm" data-act="csv-tx">📄 ${t("rep.exportTx")}</button>
        <button class="btn btn-outline btn-sm" data-act="csv-jemaat">📄 ${t("rep.exportMembers")}</button>
        <button class="btn btn-outline btn-sm" data-act="print">🖨️ ${t("rep.print")}</button>
      </div>
    </div>

    <div class="card mb">
      <div class="toolbar" style="margin-bottom:0">
        <label class="row" style="gap:8px"><span class="muted">${t("keu.period")}</span>
          <select id="rep-periode">${opsiPeriode}</select></label>
        ${state.terpotong ? `<span class="badge badge-yellow">${t("rep.truncated")}</span>` : ""}
      </div>
    </div>

    <div class="grid grid-4 mb">
      ${kartu("📥", t("keu.income"), money(r.pemasukan), esc(labelPeriode()))}
      ${kartu("📤", t("keu.expense"), money(r.pengeluaran), esc(labelPeriode()))}
      ${kartu("💰", t("keu.balance"), money(r.saldo), esc(labelPeriode()))}
      ${kartu("👥", t("dash.totalMembers"), num(j.total || 0), `${num(j.aktif || 0)} ${t("common.active").toLowerCase()} · ${num(j.pasif || 0)} ${t("common.inactive").toLowerCase()}`)}
    </div>

    <div class="grid grid-4 mb">
      ${kartu("🗄️", t("rep.assets"), String(state.jumlahAset), money(state.nilaiAset))}
      ${kartu("🚻", t("rep.gender"), `${num(j.laki || 0)} / ${num(j.perempuan || 0)}`, `${t("common.male")} / ${t("common.female")}`)}
      ${kartu("🗺️", t("rep.wards"), String(Object.keys(j.perWilayah || {}).length), t("rep.wardsSub"))}
      ${kartu("📊", t("rep.txCount"), String(state.transaksi.filter((x) => dalamPeriode(x.tanggal)).length), t("rep.txCountSub"))}
    </div>

    <div class="grid grid-2 mb">
      <div class="card">
        <div class="card-title">${t("rep.chartMonth")}</div>
        <p class="card-sub">${esc(labelPeriode())}</p>
        <div class="chart-box"><canvas id="rep-bar-bulan"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">${t("rep.chartCat")}</div>
        <p class="card-sub">${t("rep.chartCatSub")}</p>
        <div class="chart-box"><canvas id="rep-donat-kategori"></canvas></div>
      </div>
    </div>

    <div class="grid grid-2 mb">
      <div class="card">
        <div class="card-title">${t("rep.chartWard")}</div>
        <p class="card-sub">${t("rep.chartWardSub")}</p>
        <div class="chart-box"><canvas id="rep-donat-wilayah"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">${t("rep.chartAge")}</div>
        <p class="card-sub">${t("rep.chartAgeSub")}</p>
        <div class="chart-box"><canvas id="rep-bar-umur"></canvas></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${t("rep.tableTitle")} <span class="muted">— ${esc(labelPeriode())}</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>${t("keu.colDate")}</th>
              <th>${t("keu.colCategory")}</th>
              <th>${t("keu.colDesc")}</th>
              <th>${t("keu.colType")}</th>
              <th class="num">${t("keu.colAmount")}</th>
            </tr>
          </thead>
          <tbody>
            ${(() => {
              const rows = state.transaksi.filter((x) => dalamPeriode(x.tanggal)).slice(0, 100);
              if (!rows.length)
                return `<tr><td colspan="5"><div class="empty-state">
                  <span class="empty-ico">📈</span><b>${t("laporan.noData")}</b>
                  <span>${t("laporan.noDataHint")}</span></div></td></tr>`;
              return rows
                .map((x) => {
                  const masuk = x.jenis === "masuk";
                  return `<tr>
                    <td>${dateShort(x.tanggal)}</td>
                    <td>${esc(x.kategori || "—")}</td>
                    <td>${esc(x.keterangan || "—")}</td>
                    <td><span class="badge ${masuk ? "badge-green" : "badge-red"}">${masuk ? t("keu.typeIn") : t("keu.typeOut")}</span></td>
                    <td class="num">${money(x.nominal)}</td>
                  </tr>`;
                })
                .join("");
            })()}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>${t("rep.tableNote")}</span>
      </div>
    </div>`;

  pasangListener();
  buatGrafik();
}

function pasangListener() {
  const per = el.querySelector("#rep-periode");
  if (per)
    per.onchange = () => {
      state.periode = per.value;
      gambar();
    };

  el.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "print") b.onclick = () => window.print();
    else if (act === "csv-tx") b.onclick = eksporTransaksi;
    else if (act === "csv-jemaat") b.onclick = eksporJemaat;
  });
}

/* ---------------- Ekspor ---------------- */

function eksporTransaksi() {
  const rows = state.transaksi.filter((x) => dalamPeriode(x.tanggal));
  if (!rows.length) {
    toast(t("common.empty"), "error");
    return;
  }
  const head = ["Tanggal", "Jenis", "Kategori", "Keterangan", "Referensi", "Nominal"];
  const isi = rows.map((x) => [
    dateShort(x.tanggal),
    x.jenis === "masuk" ? t("keu.typeIn") : t("keu.typeOut"),
    x.kategori,
    x.keterangan,
    x.referensi,
    x.nominal,
  ]);
  unduhCSV(`laporan-keuangan-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...isi]);
  toast(t("rep.exported"), "success");
}

function eksporJemaat() {
  const j = state.jemaat;
  if (!j) {
    toast(t("common.empty"), "error");
    return;
  }
  const head = ["Metrik", "Nilai"];
  const isi = [
    ["Total Jemaat", j.total || 0],
    ["Aktif", j.aktif || 0],
    ["Pasif", j.pasif || 0],
    ["Laki-laki", j.laki || 0],
    ["Perempuan", j.perempuan || 0],
    [],
    ["Per Wilayah", ""],
    ...Object.entries(j.perWilayah || {}).map(([k, v]) => [k, v]),
    [],
    ["Per Kategori Umur", ""],
    ...Object.entries(j.perUmur || {}).map(([k, v]) => [k, v]),
  ];
  unduhCSV(`laporan-jemaat-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...isi]);
  toast(t("rep.exported"), "success");
}

/* ---------------- Modul ---------------- */

const laporan = {
  key: "laporan",

  async mount(container) {
    el = container;
    hancurkanGrafik();
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;
    try {
      await muatSemua();
      gambar();
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="card"><div class="empty-state">
        <span class="empty-ico">⚠️</span>
        <b>${t("common.error")}</b>
        <span>${esc(friendlyError(err))}</span>
      </div></div>`;
    }
  },

  unmount() {
    hancurkanGrafik();
    el = null;
  },
};

export default laporan;
