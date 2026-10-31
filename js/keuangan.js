/* =========================================================
   keuangan.js — MODUL 3: Keuangan (Proyek / Buku Kas)
   Pilih kas (Semua / per proyek), kartu pemasukan-pengeluaran-saldo,
   tabel transaksi, filter periode, CRUD transaksi & proyek.

   Hemat kuota:
     - ringkasan dibaca dari `ringkasan/kas_total` dan
       `ringkasan/kas_{proyekId}` (diperbarui delta saat transaksi
       ditambah/ubah/hapus — lihat store.js)
     - tabel transaksi: proyek tertentu → where equality limit 200;
       semua kas → orderBy tanggal desc limit 200 (+ cursor)
   ========================================================= */

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
} from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite } from "./auth.js";
import {
  esc,
  money,
  num,
  dateShort,
  dateToInput,
  dateFromInput,
  cleanText,
  cleanNumber,
  toast,
  openModal,
  closeModal,
  confirmDialog,
  friendlyError,
  toDate,
} from "./utils.js";
import {
  catatAudit,
  ambilPengaturan,
  ubahRingkasanKeuangan,
  hitungUlangKeuangan,
} from "./store.js";

const CHUNK = 200;

const state = {
  proyek: [],
  proyekAktif: "", // "" = Semua Kas
  periode: "bulan", // bulan | 3 | 12 | all
  rows: [],
  cursor: null,
  bisaMuatLagi: false,
  ringkas: { pemasukan: 0, pengeluaran: 0, saldo: 0 },
  kategoriList: [],
};

let el = null;

/* ---------------- Periode ---------------- */

function batasPeriode() {
  const now = new Date();
  switch (state.periode) {
    case "bulan":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "3":
      return new Date(now.getFullYear(), now.getMonth() - 2, 1);
    case "12":
      return new Date(now.getFullYear(), now.getFullYear() ? now.getMonth() - 11 : 0, 1);
    default:
      return null;
  }
}

function dalamPeriode(tanggal) {
  const batas = batasPeriode();
  if (!batas) return true;
  const d = toDate(tanggal);
  return d ? d >= batas : true;
}

function kunciBulan(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* ---------------- Sumber data ---------------- */

async function muatProyek() {
  const snap = await getDocs(collection(db, "proyek"));
  state.proyek = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));
}

async function muatRingkas() {
  const id = state.proyekAktif ? `kas_${state.proyekAktif}` : "kas_total";
  const snap = await getDoc(doc(db, "ringkasan", id));
  if (!snap.exists()) {
    state.ringkas = { pemasukan: 0, pengeluaran: 0, saldo: 0 };
    return;
  }
  const d = snap.data();
  const perBulan = d.perBulan || {};
  const batas = batasPeriode();
  const kunciBatas = batas ? kunciBulan(batas) : null;
  let pemasukan = 0;
  let pengeluaran = 0;
  Object.keys(perBulan).forEach((k) => {
    if (kunciBatas && k < kunciBatas) return;
    pemasukan += Number(perBulan[k].masuk) || 0;
    pengeluaran += Number(perBulan[k].keluar) || 0;
  });
  state.ringkas = { pemasukan, pengeluaran, saldo: pemasukan - pengeluaran };
}

async function muatTransaksi(reset) {
  if (reset) {
    state.cursor = null;
    state.rows = [];
    state.bisaMuatLagi = false;
  }
  const kol = collection(db, "transaksi");
  let snap;
  if (state.proyekAktif) {
    const parts = [kol, where("proyekId", "==", state.proyekAktif)];
    if (state.cursor) parts.push(startAfter(state.cursor));
    parts.push(limit(CHUNK));
    snap = await getDocs(query(...parts));
  } else {
    const parts = [kol, orderBy("tanggal", "desc")];
    if (state.cursor) parts.push(startAfter(state.cursor));
    parts.push(limit(CHUNK));
    snap = await getDocs(query(...parts));
  }
  state.cursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : state.cursor;
  state.bisaMuatLagi = snap.docs.length === CHUNK;

  const baru = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => dalamPeriode(r.tanggal));
  if (!reset) {
    const sudah = new Set(state.rows.map((r) => r.id));
    baru.forEach((r) => {
      if (!sudah.has(r.id)) state.rows.push(r);
    });
  } else {
    state.rows = baru;
  }
  state.rows.sort((a, b) => (toDate(b.tanggal)?.getTime() || 0) - (toDate(a.tanggal)?.getTime() || 0));
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

function chipProyek(b) {
  const aktif = state.proyekAktif === b.id;
  return `<button class="btn btn-sm ${aktif ? "btn-primary" : "btn-outline"}" data-proyek="${esc(b.id)}">${esc(b.nama || "(tanpa nama)")}</button>`;
}

function gambar() {
  const bolehTulis = canWrite("keuangan");
  const namaProyek =
    state.proyekAktif
      ? (state.proyek.find((p) => p.id === state.proyekAktif) || {}).nama || ""
      : t("keu.allBooks");

  const opsiPeriode = [
    ["bulan", t("keu.periodMonth")],
    ["3", t("keu.period3")],
    ["12", t("keu.period12")],
    ["all", t("keu.periodAll")],
  ]
    .map(([v, l]) => `<option value="${v}" ${state.periode === v ? "selected" : ""}>${esc(l)}</option>`)
    .join("");

  const opsiProyek = state.proyek
    .map((p) => `<option value="${esc(p.id)}" ${state.proyekAktif === p.id ? "selected" : ""}>${esc(p.nama || "(tanpa nama)")}</option>`)
    .join("");

  const opsiKategori = state.kategoriList.map((k) => `<option value="${esc(k)}"></option>`).join("");

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("keu.subtitle")} — <b>${esc(namaProyek)}</b></p>
      <div class="row">
        <button class="btn btn-outline btn-sm" data-act="recalc">🧮 ${t("keu.recalc")}</button>
        <button class="btn btn-outline btn-sm" data-act="refresh">🔄 ${t("action.refresh")}</button>
        ${bolehTulis
          ? `<button class="btn btn-outline btn-sm" data-act="add-proyek">＋ ${t("keu.addProject")}</button>
             <button class="btn btn-primary btn-sm" data-act="add-tx">＋ ${t("keu.addTx")}</button>`
          : ""}
      </div>
    </div>

    <div class="card mb">
      <div class="row">
        <button class="btn btn-sm ${state.proyekAktif === "" ? "btn-primary" : "btn-outline"}" data-proyek="">${t("keu.allBooks")}</button>
        ${state.proyek.map(chipProyek).join("")}
      </div>
    </div>

    <div class="grid grid-4 mb">
      ${kartu("📥", t("keu.income"), money(state.ringkas.pemasukan), t("keu.incomeSub"))}
      ${kartu("📤", t("keu.expense"), money(state.ringkas.pengeluaran), t("keu.expenseSub"))}
      ${kartu("💰", t("keu.balance"), money(state.ringkas.saldo), esc(namaProyek))}
      ${kartu("🗂️", t("keu.projects"), String(state.proyek.length), t("keu.projectsSub"))}
    </div>

    <div class="card">
      <div class="toolbar">
        <select id="k-periode">${opsiPeriode}</select>
        ${bolehTulis && state.proyekAktif
          ? `<button class="btn btn-outline btn-sm" data-act="edit-proyek">✏️ ${t("keu.editProject")}</button>
             <button class="btn btn-outline btn-sm" data-act="del-proyek">🗑️ ${t("keu.delProject")}</button>`
          : ""}
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>${t("keu.colDate")}</th>
              <th>${t("keu.colCategory")}</th>
              <th>${t("keu.colDesc")}</th>
              <th>${t("keu.colRef")}</th>
              <th>${t("keu.colType")}</th>
              <th class="num">${t("keu.colAmount")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${state.rows.length === 0
              ? `<tr><td colspan="7">
                   <div class="empty-state">
                     <span class="empty-ico">💰</span>
                     <b>${t("keu.empty")}</b>
                     <span>${t("keu.emptyHint")}</span>
                   </div>
                 </td></tr>`
              : state.rows
                  .map((r) => {
                    const masuk = r.jenis === "masuk";
                    return `
                      <tr>
                        <td>${dateShort(r.tanggal)}</td>
                        <td>${esc(r.kategori || "—")}</td>
                        <td>${esc(r.keterangan || "—")}</td>
                        <td>${esc(r.referensi || "—")}</td>
                        <td><span class="badge ${masuk ? "badge-green" : "badge-red"}">${masuk ? t("keu.typeIn") : t("keu.typeOut")}</span></td>
                        <td class="num"><b class="${masuk ? "c-income" : "c-expense"}">${masuk ? "+" : "−"} ${money(r.nominal)}</b></td>
                        <td class="actions">
                          ${bolehTulis
                            ? `<button class="btn btn-outline btn-sm" data-act="edit-tx" data-id="${esc(r.id)}">✏️</button>
                               <button class="btn btn-outline btn-sm" data-act="del-tx" data-id="${esc(r.id)}">🗑️</button>`
                            : `<span class="muted">—</span>`}
                        </td>
                      </tr>`;
                  })
                  .join("")}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <span>${state.rows.length} ${t("keu.shown")}</span>
        <div class="pg-btns">
          <button class="btn btn-outline btn-sm" data-act="more" ${state.bisaMuatLagi ? "" : "disabled"}>${t("keu.loadMore")}</button>
        </div>
      </div>
    </div>

    <datalist id="dl-kategori-keuangan">${opsiKategori}</datalist>`;

  pasangListener(bolehTulis);
}

function pasangListener(bolehTulis) {
  el.querySelectorAll("[data-proyek]").forEach((b) => {
    b.onclick = async () => {
      state.proyekAktif = b.dataset.proyek || "";
      await muatRingkas();
      await muatTransaksi(true);
      gambar();
    };
  });

  const per = el.querySelector("#k-periode");
  if (per)
    per.onchange = async () => {
      state.periode = per.value;
      await muatRingkas();
      await muatTransaksi(true);
      gambar();
    };

  el.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "refresh")
      b.onclick = async () => {
        await muatProyek();
        await muatRingkas();
        await muatTransaksi(true);
        gambar();
      };
    else if (act === "more")
      b.onclick = async () => {
        await muatTransaksi(false);
        gambar();
      };
    else if (act === "add-tx" && bolehTulis) b.onclick = () => formTransaksi(null);
    else if (act === "edit-tx" && bolehTulis)
      b.onclick = () => {
        const r = state.rows.find((x) => x.id === b.dataset.id);
        if (r) formTransaksi(r);
      };
    else if (act === "del-tx" && bolehTulis)
      b.onclick = () => {
        const r = state.rows.find((x) => x.id === b.dataset.id);
        if (r) hapusTransaksi(r);
      };
    else if (act === "add-proyek" && bolehTulis) b.onclick = () => formProyek(null);
    else if (act === "edit-proyek" && bolehTulis)
      b.onclick = () => {
        const p = state.proyek.find((x) => x.id === state.proyekAktif);
        if (p) formProyek(p);
      };
    else if (act === "del-proyek" && bolehTulis) b.onclick = hapusProyek;
    else if (act === "recalc") b.onclick = recalc;
  });
}

/* ---------------- Form transaksi ---------------- */

function formTransaksi(row) {
  const r = row || {};
  const jenis = r.jenis || "masuk";
  const opsiProyek = state.proyek
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${(r.proyekId || state.proyekAktif) === p.id ? "selected" : ""}>${esc(p.nama || "(tanpa nama)")}</option>`
    )
    .join("");

  const html = `
    <form id="form-tx">
      <div class="form-grid">
        <label class="field"><span>${t("keu.formProject")} *</span>
          <select name="proyekId" required>${opsiProyek}</select></label>
        <label class="field"><span>${t("keu.formDate")} *</span>
          <input type="date" name="tanggal" required value="${dateToInput(r.tanggal) || dateToInput(new Date())}" /></label>
        <label class="field"><span>${t("keu.formType")}</span>
          <select name="jenis">
            <option value="masuk" ${jenis === "masuk" ? "selected" : ""}>${t("keu.typeIn")}</option>
            <option value="keluar" ${jenis === "keluar" ? "selected" : ""}>${t("keu.typeOut")}</option>
          </select></label>
        <label class="field"><span>${t("keu.formCategory")}</span>
          <input name="kategori" list="dl-kategori-keuangan" maxlength="60" value="${esc(r.kategori || "")}" /></label>
        <label class="field full"><span>${t("keu.formDesc")}</span>
          <input name="keterangan" maxlength="200" value="${esc(r.keterangan || "")}" /></label>
        <label class="field"><span>${t("keu.formRef")}</span>
          <input name="referensi" maxlength="80" value="${esc(r.referensi || "")}" /></label>
        <label class="field"><span>${t("keu.formAmount")} *</span>
          <input name="nominal" type="number" min="0" step="1" required value="${r.nominal ?? ""}" /></label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("action.save")}</button>
      </div>
    </form>`;

  openModal(row ? t("keu.editTx") : t("keu.addTx"), html, (fd) => simpanTransaksi(fd, r));
  const batal = document.querySelector("#form-tx [data-act='batal']");
  if (batal) batal.onclick = closeModal;
}

async function simpanTransaksi(fd, old) {
  const proyekId = cleanText(fd.get("proyekId"), 40);
  const tanggal = dateFromInput(fd.get("tanggal"));
  const nominal = cleanNumber(fd.get("nominal")) || 0;
  if (!proyekId || !tanggal || nominal <= 0) {
    toast(t("keu.formInvalid"), "error");
    return;
  }
  const jenis = fd.get("jenis") === "keluar" ? "keluar" : "masuk";
  const data = {
    proyekId,
    tanggal,
    jenis,
    kategori: cleanText(fd.get("kategori"), 60),
    keterangan: cleanText(fd.get("keterangan"), 200),
    referensi: cleanText(fd.get("referensi"), 80),
    nominal,
  };

  try {
    if (old && old.id) {
      await updateDoc(doc(db, "transaksi", old.id), { ...data, updatedAt: serverTimestamp() });
      await catatAudit("Ubah transaksi", "transaksi", old.id, `${data.keterangan || "-"} (${data.jenis} ${num(nominal)})`);

      const oldMasuk = old.jenis === "masuk" ? Number(old.nominal) || 0 : 0;
      const oldKeluar = old.jenis === "keluar" ? Number(old.nominal) || 0 : 0;
      const newMasuk = jenis === "masuk" ? nominal : 0;
      const newKeluar = jenis === "keluar" ? nominal : 0;

      if (old.proyekId !== proyekId) {
        await ubahRingkasanKeuangan({ proyekId: old.proyekId, tanggal: toDate(old.tanggal) || tanggal, masuk: -oldMasuk, keluar: -oldKeluar });
        await ubahRingkasanKeuangan({ proyekId, tanggal, masuk: newMasuk, keluar: newKeluar });
      } else {
        await ubahRingkasanKeuangan({ proyekId, tanggal, masuk: newMasuk - oldMasuk, keluar: newKeluar - oldKeluar });
      }
    } else {
      const ref = await addDoc(collection(db, "transaksi"), { ...data, createdAt: serverTimestamp() });
      await catatAudit("Tambah transaksi", "transaksi", ref.id, `${data.keterangan || "-"} (${data.jenis} ${num(nominal)})`);
      await ubahRingkasanKeuangan({
        proyekId,
        tanggal,
        masuk: jenis === "masuk" ? nominal : 0,
        keluar: jenis === "keluar" ? nominal : 0,
      });
    }
    closeModal();
    toast(t("keu.txSaved"), "success");
    await muatRingkas();
    await muatTransaksi(true);
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function hapusTransaksi(row) {
  const ok = await confirmDialog(t("keu.confirmDelete"), { okLabel: t("action.delete") });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "transaksi", row.id));
    await catatAudit("Hapus transaksi", "transaksi", row.id, row.keterangan || "");
    await ubahRingkasanKeuangan({
      proyekId: row.proyekId,
      tanggal: toDate(row.tanggal) || new Date(),
      masuk: row.jenis === "masuk" ? -(Number(row.nominal) || 0) : 0,
      keluar: row.jenis === "keluar" ? -(Number(row.nominal) || 0) : 0,
    });
    toast(t("keu.txDeleted"), "success");
    await muatRingkas();
    await muatTransaksi(true);
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Form proyek ---------------- */

function formProyek(row) {
  const r = row || {};
  const html = `
    <form id="form-proyek">
      <div class="form-grid">
        <label class="field full"><span>${t("keu.projectName")} *</span>
          <input name="nama" required maxlength="80" value="${esc(r.nama || "")}" /></label>
        <label class="field full"><span>${t("keu.projectDesc")}</span>
          <textarea name="deskripsi" rows="3" maxlength="300">${esc(r.deskripsi || "")}</textarea></label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("action.save")}</button>
      </div>
    </form>`;
  openModal(row ? t("keu.editProject") : t("keu.addProject"), html, (fd) => simpanProyek(fd, r.id));
  const batal = document.querySelector("#form-proyek [data-act='batal']");
  if (batal) batal.onclick = closeModal;
}

async function simpanProyek(fd, id) {
  const nama = cleanText(fd.get("nama"), 80);
  if (!nama) {
    toast(t("keu.projectNameRequired"), "error");
    return;
  }
  const data = { nama, deskripsi: cleanText(fd.get("deskripsi"), 300) };
  try {
    if (id) {
      await updateDoc(doc(db, "proyek", id), { ...data, updatedAt: serverTimestamp() });
      await catatAudit("Ubah proyek kas", "proyek", id, nama);
    } else {
      const ref = await addDoc(collection(db, "proyek"), { ...data, createdAt: serverTimestamp() });
      await catatAudit("Tambah proyek kas", "proyek", ref.id, nama);
      state.proyekAktif = ref.id;
    }
    closeModal();
    toast(t("keu.projectSaved"), "success");
    await muatProyek();
    await muatRingkas();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function hapusProyek() {
  const p = state.proyek.find((x) => x.id === state.proyekAktif);
  if (!p) return;
  const ok = await confirmDialog(t("keu.confirmDeleteProject").replace("[NAMA]", p.nama || ""), {
    okLabel: t("action.delete"),
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "proyek", p.id));
    await catatAudit("Hapus proyek kas", "proyek", p.id, p.nama || "");
    toast(t("keu.projectDeleted"), "success");
    state.proyekAktif = "";
    await muatProyek();
    await muatRingkas();
    await muatTransaksi(true);
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function recalc() {
  const ok = await confirmDialog(t("keu.recalcConfirm"), { okLabel: t("keu.recalc"), danger: false });
  if (!ok) return;
  try {
    const hasil = await hitungUlangKeuangan();
    toast(t("keu.recalcDone").replace("[N]", hasil.totalDiproses), "success");
    await muatRingkas();
    await muatTransaksi(true);
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Modul ---------------- */

const keuangan = {
  key: "keuangan",

  async mount(container) {
    el = container;
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;
    try {
      const kategori = await ambilPengaturan("kategori");
      state.kategoriList = (kategori && kategori.keuangan) || [];
      await muatProyek();
      await muatRingkas();
      await muatTransaksi(true);
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

export default keuangan;
