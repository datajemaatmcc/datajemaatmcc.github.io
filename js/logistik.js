/* =========================================================
   logistik.js — MODUL 4: Logistik (Inventaris Aset)
   Kartu ringkasan aset, tabel + pencarian klien, filter
   kategori/kondisi, form tambah/ubah, ekspor CSV.

   Hemat kuota: satu kali baca hingga 500 dokumen `aset`,
   lalu seluruh filter/pencarian dihitung di browser —
   tanpa query tambahan, tanpa indeks komposit.
   ========================================================= */

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite } from "./auth.js";
import {
  esc,
  money,
  num,
  cleanText,
  cleanNumber,
  toast,
  openModal,
  closeModal,
  confirmDialog,
  friendlyError,
} from "./utils.js";
import { catatAudit, ambilPengaturan, unduhCSV } from "./store.js";

const MAX_DOCS = 500;

const state = {
  semua: [],
  q: "",
  kategori: "",
  kondisi: "",
  kategoriList: [],
  terpotong: false,
};

let el = null;

const KONDISI = ["Bagus", "Perlu Perbaikan", "Rusak"];

function badgeKondisi(k) {
  const cls =
    k === "Bagus" ? "badge-green" : k === "Rusak" ? "badge-red" : "badge-yellow";
  return `<span class="badge ${cls}">${esc(k || "—")}</span>`;
}

/* ---------------- Sumber data ---------------- */

async function muatSemua() {
  const [kategori, snap] = await Promise.all([
    ambilPengaturan("kategori"),
    getDocs(query(collection(db, "aset"), limit(MAX_DOCS))),
  ]);
  state.kategoriList = (kategori && kategori.inventaris) || [];
  state.semua = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.terpotong = snap.docs.length === MAX_DOCS;
  state.semua.sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));
}

function terlihat() {
  const q = state.q.toLowerCase();
  return state.semua.filter((r) => {
    if (state.kategori && r.kategori !== state.kategori) return false;
    if (state.kondisi && r.kondisi !== state.kondisi) return false;
    if (q) {
      const gabung = `${r.nama || ""} ${r.lokasi || ""} ${r.kategori || ""}`.toLowerCase();
      if (!gabung.includes(q)) return false;
    }
    return true;
  });
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
  const bolehTulis = canWrite("logistik");
  const rows = terlihat();

  const nilaiTotal = state.semua.reduce(
    (sum, r) => sum + (Number(r.jumlah) || 0) * (Number(r.hargaSatuan) || 0),
    0
  );
  const perluPerbaikan = state.semua.filter((r) => r.kondisi === "Perlu Perbaikan").length;
  const rusak = state.semua.filter((r) => r.kondisi === "Rusak").length;

  const opsiKategori = state.kategoriList
    .map((k) => `<option value="${esc(k)}" ${state.kategori === k ? "selected" : ""}>${esc(k)}</option>`)
    .join("");
  const opsiKondisi = KONDISI.map(
    (k) => `<option value="${esc(k)}" ${state.kondisi === k ? "selected" : ""}>${esc(k)}</option>`
  ).join("");
  const dlKategori = state.kategoriList.map((k) => `<option value="${esc(k)}"></option>`).join("");

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("log.subtitle")}</p>
      <div class="row">
        <button class="btn btn-outline btn-sm" data-act="export">📄 ${t("action.export")}</button>
        <button class="btn btn-outline btn-sm" data-act="refresh">🔄 ${t("action.refresh")}</button>
        ${bolehTulis ? `<button class="btn btn-primary btn-sm" data-act="add">＋ ${t("log.add")}</button>` : ""}
      </div>
    </div>

    <div class="grid grid-4 mb">
      ${kartu("📦", t("log.total"), String(state.semua.length), t("log.totalSub"))}
      ${kartu("💵", t("log.value"), money(nilaiTotal), t("log.valueSub"))}
      ${kartu("🛠️", t("log.needsFix"), String(perluPerbaikan), t("log.needsFixSub"))}
      ${kartu("🚨", t("log.broken"), String(rusak), t("log.brokenSub"))}
    </div>

    <div class="card">
      <div class="toolbar">
        <input id="a-q" class="grow" type="search" placeholder="${esc(t("log.searchPh"))}" value="${esc(state.q)}" />
        <select id="a-kategori">
          <option value="">${t("log.allCat")}</option>
          ${opsiKategori}
        </select>
        <select id="a-kondisi">
          <option value="">${t("log.allCond")}</option>
          ${opsiKondisi}
        </select>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>${t("log.colName")}</th>
              <th>${t("log.colCat")}</th>
              <th class="num">${t("log.colQty")}</th>
              <th>${t("log.colCond")}</th>
              <th>${t("log.colLoc")}</th>
              <th class="num">${t("log.colPrice")}</th>
              <th class="num">${t("log.colTotal")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0
              ? `<tr><td colspan="8">
                   <div class="empty-state">
                     <span class="empty-ico">📦</span>
                     <b>${state.semua.length ? t("log.noMatch") : t("log.empty")}</b>
                     <span>${state.semua.length ? t("log.noMatchHint") : t("log.emptyHint")}</span>
                   </div>
                 </td></tr>`
              : rows
                  .map((r) => {
                    const jumlah = Number(r.jumlah) || 0;
                    const harga = Number(r.hargaSatuan) || 0;
                    return `
                      <tr>
                        <td><b>${esc(r.nama || "(tanpa nama)")}</b></td>
                        <td>${r.kategori ? `<span class="badge badge-blue">${esc(r.kategori)}</span>` : "—"}</td>
                        <td class="num">${num(jumlah)}</td>
                        <td>${badgeKondisi(r.kondisi)}</td>
                        <td>${esc(r.lokasi || "—")}</td>
                        <td class="num">${money(harga)}</td>
                        <td class="num"><b>${money(jumlah * harga)}</b></td>
                        <td class="actions">
                          ${bolehTulis
                            ? `<button class="btn btn-outline btn-sm" data-act="edit" data-id="${esc(r.id)}">✏️</button>
                               <button class="btn btn-outline btn-sm" data-act="hapus" data-id="${esc(r.id)}">🗑️</button>`
                            : `<span class="muted">—</span>`}
                        </td>
                      </tr>`;
                  })
                  .join("")}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <span>${rows.length} ${t("log.shown")} ${state.terpotong ? `· ${t("log.truncated")}` : ""}</span>
      </div>
    </div>

    <datalist id="dl-kategori-aset">${dlKategori}</datalist>`;

  pasangListener(bolehTulis);
}

function pasangListener(bolehTulis) {
  const q = el.querySelector("#a-q");
  if (q)
    q.oninput = () => {
      state.q = q.value.trim();
      const pos = q.selectionStart;
      gambar();
      const inp = el.querySelector("#a-q");
      if (inp) {
        inp.focus();
        inp.setSelectionRange(pos, pos);
      }
    };

  const kat = el.querySelector("#a-kategori");
  if (kat)
    kat.onchange = () => {
      state.kategori = kat.value;
      gambar();
    };

  const kon = el.querySelector("#a-kondisi");
  if (kon)
    kon.onchange = () => {
      state.kondisi = kon.value;
      gambar();
    };

  el.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "refresh")
      b.onclick = async () => {
        await muatSemua();
        gambar();
      };
    else if (act === "export") b.onclick = eksporCSV;
    else if (act === "add" && bolehTulis) b.onclick = () => formAset(null);
    else if (act === "edit" && bolehTulis)
      b.onclick = () => {
        const r = state.semua.find((x) => x.id === b.dataset.id);
        if (r) formAset(r);
      };
    else if (act === "hapus" && bolehTulis)
      b.onclick = () => {
        const r = state.semua.find((x) => x.id === b.dataset.id);
        if (r) hapus(r);
      };
  });
}

/* ---------------- Form aset ---------------- */

function formAset(row) {
  const r = row || {};
  const opsiKondisi = KONDISI.map(
    (k) => `<option value="${esc(k)}" ${(r.kondisi || "Bagus") === k ? "selected" : ""}>${esc(k)}</option>`
  ).join("");
  const dlKategori = state.kategoriList.map((k) => `<option value="${esc(k)}"></option>`).join("");

  const html = `
    <form id="form-aset">
      <div class="form-grid">
        <label class="field full"><span>${t("log.formName")} *</span>
          <input name="nama" required maxlength="120" value="${esc(r.nama || "")}" /></label>
        <label class="field"><span>${t("log.formCat")}</span>
          <input name="kategori" list="dl-kategori-aset-form" maxlength="60" value="${esc(r.kategori || "")}" />
          <datalist id="dl-kategori-aset-form">${dlKategori}</datalist></label>
        <label class="field"><span>${t("log.formQty")}</span>
          <input name="jumlah" type="number" min="0" step="1" value="${r.jumlah ?? 1}" /></label>
        <label class="field"><span>${t("log.formCond")}</span>
          <select name="kondisi">${opsiKondisi}</select></label>
        <label class="field"><span>${t("log.formLoc")}</span>
          <input name="lokasi" maxlength="80" value="${esc(r.lokasi || "")}" /></label>
        <label class="field"><span>${t("log.formPrice")}</span>
          <input name="hargaSatuan" type="number" min="0" step="1" value="${r.hargaSatuan ?? ""}" /></label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("action.save")}</button>
      </div>
    </form>`;

  openModal(row ? `${t("action.edit")} — ${r.nama || ""}` : t("log.add"), html, (fd) => simpan(fd, r.id));
  const batal = document.querySelector("#form-aset [data-act='batal']");
  if (batal) batal.onclick = closeModal;
}

async function simpan(fd, id) {
  const nama = cleanText(fd.get("nama"), 120);
  if (!nama) {
    toast(t("log.nameRequired"), "error");
    return;
  }
  const data = {
    nama,
    kategori: cleanText(fd.get("kategori"), 60),
    jumlah: cleanNumber(fd.get("jumlah")) ?? 0,
    kondisi: KONDISI.includes(fd.get("kondisi")) ? fd.get("kondisi") : "Bagus",
    lokasi: cleanText(fd.get("lokasi"), 80),
    hargaSatuan: cleanNumber(fd.get("hargaSatuan")) ?? 0,
  };

  try {
    if (id) {
      await updateDoc(doc(db, "aset", id), { ...data, updatedAt: serverTimestamp() });
      await catatAudit("Ubah aset", "aset", id, nama);
    } else {
      const ref = await addDoc(collection(db, "aset"), { ...data, createdAt: serverTimestamp() });
      await catatAudit("Tambah aset", "aset", ref.id, nama);
    }
    closeModal();
    toast(t("log.saved"), "success");
    await muatSemua();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function hapus(row) {
  const ok = await confirmDialog(t("log.confirmDelete").replace("[NAMA]", row.nama || ""), {
    okLabel: t("action.delete"),
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "aset", row.id));
    await catatAudit("Hapus aset", "aset", row.id, row.nama || "");
    toast(t("log.deleted"), "success");
    await muatSemua();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Ekspor CSV ---------------- */

function eksporCSV() {
  const rows = terlihat();
  if (!rows.length) {
    toast(t("common.empty"), "error");
    return;
  }
  const head = ["Nama", "Kategori", "Jumlah", "Kondisi", "Lokasi", "Harga Satuan", "Total"];
  const isi = rows.map((r) => [
    r.nama,
    r.kategori,
    r.jumlah,
    r.kondisi,
    r.lokasi,
    r.hargaSatuan,
    (Number(r.jumlah) || 0) * (Number(r.hargaSatuan) || 0),
  ]);
  unduhCSV(`logistik-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...isi]);
  toast(t("log.exported"), "success");
}

/* ---------------- Modul ---------------- */

const logistik = {
  key: "logistik",

  async mount(container) {
    el = container;
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
    el = null;
  },
};

export default logistik;
