/* =========================================================
   jemaat.js — MODUL 2: Data Jemaat
   Tabel + pagination cursor Firestore, pencarian awalan nama,
   filter status/wilayah, form tambah/edit, ekspor CSV.

   Hemat kuota:
     - jelajah biasa : orderBy("nama") + limit 25 + startAfter
     - cari          : where nama range (awalan) limit 50
     - filter        : where satu field equality limit 200
                       (tanpa indeks komposit)
   Setiap simpan/hapus memicu hitung ulang `ringkasan/jemaat`
   memakai agregat (getCountFromServer), bukan membaca dokumen.
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
  getCountFromServer,
} from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite } from "./auth.js";
import {
  esc,
  toast,
  dateShort,
  dateToInput,
  dateFromInput,
  dayMonth,
  cleanText,
  openModal,
  closeModal,
  confirmDialog,
  friendlyError,
} from "./utils.js";
import {
  catatAudit,
  ambilPengaturan,
  kategoriUmurDari,
  hitungRingkasanJemaat,
  unduhCSV,
} from "./store.js";

const PAGE = 25;

const state = {
  q: "",
  status: "",
  wilayah: "",
  rows: [],
  cursor: null,
  lastDoc: null,
  stack: [],
  page: 1,
  sumber: "jelajah", // jelajah | cari | filter
  wilayahList: [],
  batasUmur: null,
  stat: { total: 0, aktif: 0, pasif: 0, laki: 0, perempuan: 0 },
};

let el = null;
let cariTimmer = null;

/* ---------------- Sumber data ---------------- */

async function muatKonfigurasi() {
  const [kategori, profil, snap] = await Promise.all([
    ambilPengaturan("kategori"),
    ambilPengaturan("profil"),
    getDoc(doc(db, "ringkasan", "jemaat")),
  ]);
  state.wilayahList = (kategori && kategori.wilayah) || [];
  state.batasUmur = (profil && profil.batasUmur) || null;
  if (snap.exists()) {
    const d = snap.data();
    state.stat = {
      total: d.total || 0,
      aktif: d.aktif || 0,
      pasif: d.pasif || 0,
      laki: d.laki || 0,
      perempuan: d.perempuan || 0,
    };
  } else {
    const kol = collection(db, "jemaat");
    const hitung = (q) => getCountFromServer(q).then((s) => s.data().count);
    const [total, aktif] = await Promise.all([hitung(kol), hitung(query(kol, where("status", "==", "Aktif")))]);
    state.stat = { total, aktif, pasif: Math.max(total - aktif, 0), laki: 0, perempuan: 0 };
  }
}

/** Ambil data sesuai mode pencarian/filter yang aktif. */
async function muatData() {
  const kol = collection(db, "jemaat");
  let snap = null;

  if (state.q) {
    state.sumber = "cari";
    const q = state.q;
    snap = await getDocs(
      query(kol, where("nama", ">=", q), where("nama", "<=", q + "\uf8ff"), orderBy("nama"), limit(50))
    );
  } else if (state.status) {
    state.sumber = "filter";
    snap = await getDocs(query(kol, where("status", "==", state.status), limit(200)));
  } else if (state.wilayah) {
    state.sumber = "filter";
    snap = await getDocs(query(kol, where("wilayah", "==", state.wilayah), limit(200)));
  } else {
    state.sumber = "jelajah";
    const parts = [kol, orderBy("nama")];
    if (state.cursor) parts.push(startAfter(state.cursor));
    parts.push(limit(PAGE));
    snap = await getDocs(query(...parts));
  }

  state.lastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  state.rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (state.sumber !== "jelajah") {
    state.rows.sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));
  }
}

/** Hitung ulang ringkasan tanpa menggugurkan alur utama bila gagal. */
async function sinkronRingkasan() {
  try {
    await hitungRingkasanJemaat();
  } catch (err) {
    console.warn("Ringkasan jemaat gagal dihitung ulang:", err);
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

function barisTabel(r, bolehTulis) {
  const umur = r.tanggalLahir ? hitungUmur(r.tanggalLahir) : null;
  const lahir = dateShort(r.tanggalLahir);
  return `
    <tr>
      <td><b>${esc(r.nama || "(tanpa nama)")}</b>${r.nik ? `<div class="muted">NIK ${esc(r.nik)}</div>` : ""}</td>
      <td>${r.jenisKelamin === "P" ? t("common.female") : t("common.male")}</td>
      <td>${lahir}${umur !== null ? ` <span class="muted">· ${umur} th</span>` : ""}</td>
      <td>${esc(r.wilayah || "—")}</td>
      <td>${esc(r.noHp || "—")}</td>
      <td>${r.kategoriUmur ? `<span class="badge badge-purple">${esc(r.kategoriUmur)}</span>` : "—"}</td>
      <td><span class="badge ${r.status === "Pasif" ? "badge-gray" : "badge-green"}">${esc(r.status || "Aktif")}</span></td>
      <td class="actions">
        ${bolehTulis
          ? `<button class="btn btn-outline btn-sm" data-act="edit" data-id="${esc(r.id)}">✏️</button>
             <button class="btn btn-outline btn-sm" data-act="hapus" data-id="${esc(r.id)}">🗑️</button>`
          : `<span class="muted">—</span>`}
      </td>
    </tr>`;
}

function hitungUmur(value) {
  const d = dateToInput(value);
  if (!d) return null;
  const now = new Date();
  const [y, m, day] = d.split("-").map(Number);
  let umur = now.getFullYear() - y;
  const mm = now.getMonth() + 1 - m;
  if (mm < 0 || (mm === 0 && now.getDate() < day)) umur--;
  return umur;
}

function gambar() {
  const bolehTulis = canWrite("jemaat");
  const kosong = state.rows.length === 0;

  const opsiStatus = ["Aktif", "Pasif"]
    .map((s) => `<option value="${s}" ${state.status === s ? "selected" : ""}>${s}</option>`)
    .join("");
  const opsiWilayah = state.wilayahList
    .map((w) => `<option value="${esc(w)}" ${state.wilayah === w ? "selected" : ""}>${esc(w)}</option>`)
    .join("");

  const catatan =
    state.sumber === "cari"
      ? t("jemaat.noteSearch")
      : state.sumber === "filter"
      ? t("jemaat.noteFilter")
      : "";

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("jemaat.subtitle")}</p>
      <div class="row">
        <button class="btn btn-outline btn-sm" data-act="export">📄 ${t("action.export")}</button>
        <button class="btn btn-outline btn-sm" data-act="refresh">🔄 ${t("action.refresh")}</button>
        ${bolehTulis
          ? `<button class="btn btn-outline btn-sm" data-act="import">📥 ${t("jemaat.import")}</button>
             <button class="btn btn-primary btn-sm" data-act="add">＋ ${t("jemaat.add")}</button>`
          : ""}
      </div>
    </div>

    <div class="grid grid-4 mb">
      ${kartu("👥", t("dash.totalMembers"), String(state.stat.total), `${state.stat.laki || 0} ${t("common.male").toLowerCase()} · ${state.stat.perempuan || 0} ${t("common.female").toLowerCase()}`)}
      ${kartu("🟢", t("common.active"), String(state.stat.aktif), t("jemaat.statActive"))}
      ${kartu("⚪", t("common.inactive"), String(state.stat.pasif), t("jemaat.statInactive"))}
      ${kartu("🗺️", t("jemaat.colWard"), String(state.wilayahList.length), t("jemaat.statWard"))}
    </div>

    <div class="card">
      <div class="toolbar">
        <input id="j-q" class="grow" type="search" placeholder="${esc(t("jemaat.searchPh"))}" value="${esc(state.q)}" />
        <select id="j-status">
          <option value="">${t("jemaat.allStatus")}</option>
          ${opsiStatus}
        </select>
        <select id="j-wilayah">
          <option value="">${t("jemaat.allWard")}</option>
          ${opsiWilayah}
        </select>
      </div>

      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>${t("jemaat.colName")}</th>
              <th>${t("jemaat.colGender")}</th>
              <th>${t("jemaat.colBirth")}</th>
              <th>${t("jemaat.colWard")}</th>
              <th>${t("jemaat.colPhone")}</th>
              <th>${t("jemaat.colAge")}</th>
              <th>${t("jemaat.colStatus")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${kosong
              ? `<tr><td colspan="8">
                   <div class="empty-state">
                     <span class="empty-ico">👥</span>
                     <b>${t("jemaat.empty")}</b>
                     <span>${t("jemaat.emptyHint")}</span>
                   </div>
                 </td></tr>`
              : state.rows.map((r) => barisTabel(r, bolehTulis)).join("")}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <span>${state.rows.length} ${t("jemaat.shown")}${catatan ? ` · ${esc(catatan)}` : ""}</span>
        <div class="pg-btns">
          <button class="btn btn-outline btn-sm" data-act="prev" ${state.page === 1 ? "disabled" : ""}>← ${t("common.prev")}</button>
          <button class="btn btn-outline btn-sm" data-act="next" ${state.sumber !== "jelajah" || !state.lastDoc || state.rows.length < PAGE ? "disabled" : ""}>${t("common.next")} →</button>
        </div>
      </div>
    </div>`;

  pasangListener(bolehTulis);
}

function pasangListener(bolehTulis) {
  el.querySelectorAll("[data-act]").forEach((b) => {
    const act = b.dataset.act;
    if (act === "refresh") b.onclick = () => muat().then(gambar);
    else if (act === "export") b.onclick = eksporCSV;
    else if (act === "add" && bolehTulis) b.onclick = () => formJemaat(null);
    else if (act === "import" && bolehTulis) b.onclick = pilihFileImpor;
    else if (act === "edit" && bolehTulis)
      b.onclick = () => {
        const r = state.rows.find((x) => x.id === b.dataset.id);
        if (r) formJemaat(r);
      };
    else if (act === "hapus" && bolehTulis)
      b.onclick = () => {
        const r = state.rows.find((x) => x.id === b.dataset.id);
        if (r) hapus(r);
      };
    else if (act === "prev")
      b.onclick = () => {
        if (state.stack.length) {
          state.stack.pop();
          state.cursor = state.stack.length ? state.stack[state.stack.length - 1] : null;
          state.page = Math.max(1, state.page - 1);
          muatData().then(gambar);
        }
      };
    else if (act === "next")
      b.onclick = () => {
        if (state.lastDoc) {
          state.stack.push(state.lastDoc);
          state.cursor = state.lastDoc;
          state.page++;
          muatData().then(gambar);
        }
      };
  });

  const qInput = el.querySelector("#j-q");
  if (qInput) {
    qInput.addEventListener("input", () => {
      clearTimeout(cariTimmer);
      cariTimmer = setTimeout(() => {
        state.q = qInput.value.trim();
        state.status = "";
        state.wilayah = "";
        state.cursor = null;
        state.stack = [];
        state.page = 1;
        muatData().then(() => {
          gambar();
          const inp = el.querySelector("#j-q");
          if (inp) {
            inp.focus();
            inp.setSelectionRange(inp.value.length, inp.value.length);
          }
        });
      }, 450);
    });
  }

  const selStatus = el.querySelector("#j-status");
  if (selStatus)
    selStatus.onchange = () => {
      state.status = selStatus.value;
      state.q = "";
      state.wilayah = "";
      muatData().then(gambar);
    };

  const selWil = el.querySelector("#j-wilayah");
  if (selWil)
    selWil.onchange = () => {
      state.wilayah = selWil.value;
      state.q = "";
      state.status = "";
      muatData().then(gambar);
    };
}

/* ---------------- Form tambah / ubah ---------------- */

function formJemaat(row) {
  const r = row || {};
  const opsiWilayah = state.wilayahList.map((w) => `<option value="${esc(w)}"></option>`).join("");

  const html = `
    <form id="form-jemaat">
      <div class="form-grid">
        <label class="field"><span>${t("jemaat.name")} *</span>
          <input name="nama" required maxlength="120" value="${esc(r.nama || "")}" /></label>
        <label class="field"><span>${t("jemaat.nickname")} <span class="muted">(${t("jemaat.optional")})</span></span>
          <input name="namaPanggilan" maxlength="60" value="${esc(r.namaPanggilan || "")}" /></label>
        <label class="field"><span>${t("jemaat.gender")}</span>
          <select name="jenisKelamin">
            <option value="L" ${r.jenisKelamin !== "P" ? "selected" : ""}>${t("common.male")}</option>
            <option value="P" ${r.jenisKelamin === "P" ? "selected" : ""}>${t("common.female")}</option>
          </select></label>
        <label class="field"><span>${t("jemaat.status")}</span>
          <select name="status">
            <option ${r.status !== "Pasif" ? "selected" : ""}>Aktif</option>
            <option ${r.status === "Pasif" ? "selected" : ""}>Pasif</option>
          </select></label>
        <label class="field"><span>${t("jemaat.birthDate")}</span>
          <input type="date" name="tanggalLahir" value="${dateToInput(r.tanggalLahir)}" /></label>
        <label class="field"><span>${t("jemaat.marriageDate")}</span>
          <input type="date" name="tanggalNikah" value="${dateToInput(r.tanggalNikah)}" /></label>
        <label class="field"><span>${t("jemaat.ward")}</span>
          <input name="wilayah" list="dl-wilayah" maxlength="60" value="${esc(r.wilayah || "")}" />
          <datalist id="dl-wilayah">${opsiWilayah}</datalist></label>
        <label class="field"><span>${t("jemaat.phone")}</span>
          <input name="noHp" maxlength="24" value="${esc(r.noHp || "")}" /></label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("action.save")}</button>
      </div>
    </form>`;

  openModal(row ? `${t("action.edit")} — ${r.nama || ""}` : t("jemaat.add"), html, (fd) => simpan(fd, r.id));
  const batal = document.querySelector('#form-jemaat [data-act="batal"]');
  if (batal) batal.onclick = closeModal;
}

async function simpan(fd, id) {
  const nama = cleanText(fd.get("nama"), 120);
  if (!nama) {
    toast(t("jemaat.nameRequired"), "error");
    return;
  }
  const tanggalLahir = dateFromInput(fd.get("tanggalLahir"));
  const tanggalNikah = dateFromInput(fd.get("tanggalNikah"));
  const data = {
    nama,
    namaPanggilan: cleanText(fd.get("namaPanggilan"), 60),
    jenisKelamin: fd.get("jenisKelamin") === "P" ? "P" : "L",
    status: fd.get("status") === "Pasif" ? "Pasif" : "Aktif",
    tanggalLahir: tanggalLahir || null,
    tanggalNikah: tanggalNikah || null,
    wilayah: cleanText(fd.get("wilayah"), 60),
    noHp: cleanText(fd.get("noHp"), 24),
    ultahMD: dayMonth(tanggalLahir),
    annivMD: dayMonth(tanggalNikah),
    kategoriUmur: kategoriUmurDari(tanggalLahir, state.batasUmur),
    updatedAt: serverTimestamp(),
  };

  try {
    if (id) {
      await updateDoc(doc(db, "jemaat", id), data);
      await catatAudit("Ubah jemaat", "jemaat", id, nama);
    } else {
      const ref = await addDoc(collection(db, "jemaat"), { ...data, createdAt: serverTimestamp() });
      await catatAudit("Tambah jemaat", "jemaat", ref.id, nama);
    }
    closeModal();
    toast(t("jemaat.saved"), "success");
    await sinkronRingkasan();
    await muatKonfigurasi();
    await muatData();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function hapus(row) {
  const ok = await confirmDialog(t("jemaat.confirmDelete").replace("[NAMA]", row.nama || ""), {
    okLabel: t("action.delete"),
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "jemaat", row.id));
    await catatAudit("Hapus jemaat", "jemaat", row.id, row.nama || "");
    toast(t("jemaat.deleted"), "success");
    await sinkronRingkasan();
    await muatKonfigurasi();
    await muatData();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Ekspor CSV ---------------- */

function eksporCSV() {
  if (!state.rows.length) {
    toast(t("common.empty"), "error");
    return;
  }
  const head = ["Nama", "NIK", "Jenis Kelamin", "Tanggal Lahir", "Umur", "Wilayah", "No HP", "No KK", "Kategori Umur", "Status"];
  const isi = state.rows.map((r) => [
    r.nama,
    r.nik,
    r.jenisKelamin === "P" ? "Perempuan" : "Laki-laki",
    dateShort(r.tanggalLahir),
    hitungUmur(r.tanggalLahir) ?? "",
    r.wilayah,
    r.noHp,
    r.noKk,
    r.kategoriUmur,
    r.status || "Aktif",
  ]);
  unduhCSV(`data-jemaat-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...isi]);
  toast(t("jemaat.exported"), "success");
}

/* ---------------- Impor Excel ---------------- */

/** Daftar field form jemaat dipakai untuk pemetaan kolom saat impor. */
const FIELD_IMPOR = [
  { key: "nama", label: () => t("jemaat.name"), wajib: true,
    alias: ["nama", "nama lengkap", "nama jemaat", "name", "fullname"] },
  { key: "namaPanggilan", label: () => t("jemaat.nickname"),
    alias: ["nama panggilan", "panggilan", "panggil", "sapaan", "nickname", "nick"] },
  { key: "jenisKelamin", label: () => t("jemaat.gender"),
    alias: ["jenis kelamin", "kelamin", "jk", "gender", "sex"] },
  { key: "status", label: () => t("jemaat.status"), alias: ["status"] },
  { key: "tanggalLahir", label: () => t("jemaat.birthDate"),
    alias: ["tanggal lahir", "tgl lahir", "lahir", "ttl", "birth date", "birthdate"] },
  { key: "tanggalNikah", label: () => t("jemaat.marriageDate"),
    alias: ["tanggal nikah", "tgl nikah", "nikah", "tanggal pernikahan", "marriage date", "anniversary"] },
  { key: "wilayah", label: () => t("jemaat.ward"), alias: ["wilayah", "sektor", "daerah", "ward"] },
  { key: "noHp", label: () => t("jemaat.phone"),
    alias: ["no hp", "nomor hp", "nomor handphone", "no telp", "no telepon", "telepon", "telp", "hp", "phone", "whatsapp", "wa"] },
];

/** Isi file hasil pembacaan (array of array). */
let imporRows = [];
let imporNamaFile = "";
let xlsxPromise = null;

const XLSX_URLS = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
];

/** Muat SheetJS sekali saja (lazily), dengan cadangan CDN. */
function muatXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = (async () => {
    let galat = null;
    for (const url of XLSX_URLS) {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = url;
          s.onload = res;
          s.onerror = () => rej(new Error(`Gagal memuat ${url}`));
          document.head.appendChild(s);
        });
        if (window.XLSX) return window.XLSX;
      } catch (e) {
        galat = e;
      }
    }
    xlsxPromise = null;
    throw galat || new Error("SheetJS tidak tersedia");
  })();
  return xlsxPromise;
}

/** Huruf kolom Excel: 0 → A, 25 → Z, 26 → AA. */
function hurufKolom(i) {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Normalkan judul kolom agar bisa dicocokkan dengan alias field. */
function normJudul(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[.,#()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tebak apakah baris pertama adalah judul kolom. */
function tebakHeader(baris) {
  if (!baris) return false;
  if (baris.some((c) => c instanceof Date)) return false;
  const norm = baris.map(normJudul);
  if (FIELD_IMPOR.some((f) => f.alias.some((a) => norm.includes(normJudul(a))))) return true;
  const terisi = norm.filter(Boolean);
  if (!terisi.length) return false;
  // Semua berupa teks biasa (bukan angka/tanggal) → kemungkinan judul.
  return terisi.every(
    (s) => !/^\d+$/.test(s) && !/^\d+([.,]\d+)?$/.test(s) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)
  );
}

/** Tebak pemetaan kolom → field dari baris judul. */
function tebakPeta(barisJudul) {
  const peta = {};
  FIELD_IMPOR.forEach((f) => (peta[f.key] = ""));
  if (!barisJudul) return peta;
  barisJudul.forEach((h, i) => {
    const n = normJudul(h);
    if (!n) return;
    const f = FIELD_IMPOR.find((x) => peta[x.key] === "" && x.alias.some((a) => normJudul(a) === n));
    if (f) peta[f.key] = i;
  });
  return peta;
}

/** Baca file Excel/CSV → array of array (baris terisi saja). */
async function bacaFileImpor(file) {
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = window.XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });
  return rows.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
}

function nilai(r, i) {
  if (i < 0 || i === "" || i === null || i === undefined) return "";
  const v = r[i];
  return v === null || v === undefined ? "" : v;
}

function tanggalBaru(y, m, d) {
  if (!y || !m || !d || m > 12 || d > 31) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  if (isNaN(dt.getTime()) || dt.getDate() !== d) return null;
  return dt;
}

/** Nilai sel apa pun → Date (jam 12:00) atau null. */
function keTanggal(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    return isNaN(v.getTime())
      ? null
      : new Date(v.getFullYear(), v.getMonth(), v.getDate(), 12, 0, 0);
  }
  const s = String(v).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return tanggalBaru(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return tanggalBaru(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    let thn = +m[3];
    if (thn < 100) thn += thn < 70 ? 2000 : 1900;
    return tanggalBaru(thn, +m[2], +m[1]);
  }

  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400000));
    if (!isNaN(d.getTime())) {
      const thn = d.getUTCFullYear();
      if (thn >= 1900 && thn <= 2200) return new Date(thn, d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
      return null;
    }
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
}

/** Nilai sel → kode jenis kelamin L/P. */
function keGender(v) {
  const s = String(v ?? "").toLowerCase().trim();
  if (s.startsWith("p") || s.startsWith("w") || s.startsWith("f")) return "P";
  return "L";
}

/** Nilai sel → status Aktif/Pasif. */
function keStatus(v) {
  const s = String(v ?? "").toLowerCase().trim();
  return /pasif|inactive|non\s?aktif/.test(s) ? "Pasif" : "Aktif";
}

/** Tampilkan nilai sel pada pratinjau. */
function selTeks(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return dateShort(v);
  return String(v).slice(0, 60);
}

/** Minta file ke pengguna lalu siapkan dialog pemetaan kolom. */
function pilihFileImpor() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept =
    ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    imporNamaFile = file.name;
    try {
      await muatXLSX();
      const rows = await bacaFileImpor(file);
      if (!rows.length) {
        toast(t("jemaat.importEmpty"), "error");
        return;
      }
      imporRows = rows;
      // Minimal selalu A–I (jumlah field form + 1) supaya semua field
      // tetap bisa dipetakan walau file punya kolom lebih sedikit.
      let kolom = FIELD_IMPOR.length + 1;
      rows.forEach((r) => {
        if (r.length > kolom) kolom = r.length;
      });
      const header = tebakHeader(rows[0]);
      bukaModalImpor({ kolom, header, peta: tebakPeta(header ? rows[0] : null) });
    } catch (err) {
      console.error(err);
      toast(t("jemaat.importFailed"), "error");
    }
  };
  inp.click();
}

/** Popup: pratinjau isi file + form pemetaan kolom (Nama: Kolom A, dst.). */
function bukaModalImpor({ kolom, header, peta }) {
  const daftar = [];
  for (let i = 0; i < kolom; i++) daftar.push(i);
  const batas = Math.min(kolom, 12);

  const opsi = (terpilih) =>
    `<option value="">${t("jemaat.importIgnore")}</option>` +
    daftar
      .map((i) => `<option value="${i}" ${String(i) === String(terpilih) ? "selected" : ""}>${t("jemaat.importColumn")} ${hurufKolom(i)}</option>`)
      .join("");

  const jmlBaris = Math.max(imporRows.length - (header ? 1 : 0), 0);
  const preview = imporRows.slice(0, 4);

  const html = `
    <form id="form-impor">
      <p class="muted" style="margin-top:0">${esc(imporNamaFile)} · ${t("jemaat.importHint")}</p>

      <label class="row" style="margin-bottom:14px">
        <input type="checkbox" name="header" ${header ? "checked" : ""} style="width:auto" />
        <span>${t("jemaat.importHeaderRow")}</span>
      </label>

      <p class="muted" style="margin:0 0 8px"><b>${t("jemaat.importMapTitle")}</b></p>
      <div class="form-grid">
        ${FIELD_IMPOR.map(
          (f) => `<label class="field"><span>${f.label()}${f.wajib ? " *" : ""}</span>
            <select name="map_${f.key}">${opsi(peta[f.key])}</select></label>`
        ).join("")}
      </div>

      <p class="muted" style="margin:16px 0 8px">
        <b>${t("jemaat.importPreview")}</b> · ${t("jemaat.importCount").replace("[N]", String(jmlBaris))}
      </p>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>${daftar.slice(0, batas).map((i) => `<th>${t("jemaat.importColumn")} ${hurufKolom(i)}</th>`).join("")}</tr></thead>
          <tbody>
            ${preview
              .map(
                (r) =>
                  `<tr>${daftar.slice(0, batas).map((i) => `<td>${esc(selTeks(r[i]))}</td>`).join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
      ${kolom > batas ? `<p class="muted">… +${kolom - batas} ${t("jemaat.importColumn").toLowerCase()}</p>` : ""}

      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("jemaat.import")} (${jmlBaris})</button>
      </div>
    </form>`;

  openModal(t("jemaat.importTitle"), html, (fd) => jalankanImpor(fd));

  const form = document.getElementById("form-impor");
  if (!form) return;
  const batal = form.querySelector('[data-act="batal"]');
  if (batal) batal.onclick = closeModal;

  // Ubah centang "baris pertama = judul" → petakan ulang otomatis.
  const cb = form.elements.namedItem("header");
  if (cb)
    cb.onchange = () => {
      const p = tebakPeta(cb.checked ? imporRows[0] : null);
      FIELD_IMPOR.forEach((f) => {
        const sel = form.elements.namedItem(`map_${f.key}`);
        if (sel) sel.value = String(p[f.key]);
      });
    };
}

/** Simpan baris hasil pemetaan ke Firestore. */
async function jalankanImpor(fd) {
  const header = fd.get("header") === "on";
  const peta = {};
  FIELD_IMPOR.forEach((f) => {
    const v = fd.get(`map_${f.key}`);
    peta[f.key] = v === null || v === undefined || v === "" ? -1 : Number(v);
  });
  if (peta.nama < 0) {
    toast(t("jemaat.importNoMap"), "error");
    return;
  }

  const isi = header ? imporRows.slice(1) : imporRows;
  const data = [];
  isi.forEach((r) => {
    const nama = cleanText(nilai(r, peta.nama), 120);
    if (!nama) return;
    const tLahir = keTanggal(nilai(r, peta.tanggalLahir));
    const tNikah = keTanggal(nilai(r, peta.tanggalNikah));
    data.push({
      nama,
      namaPanggilan: cleanText(nilai(r, peta.namaPanggilan), 60),
      jenisKelamin: keGender(nilai(r, peta.jenisKelamin)),
      status: keStatus(nilai(r, peta.status)),
      tanggalLahir: tLahir,
      tanggalNikah: tNikah,
      wilayah: cleanText(nilai(r, peta.wilayah), 60),
      noHp: cleanText(nilai(r, peta.noHp), 24),
      ultahMD: dayMonth(tLahir),
      annivMD: dayMonth(tNikah),
      kategoriUmur: kategoriUmurDari(tLahir, state.batasUmur),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  if (!data.length) {
    toast(t("jemaat.importNoName"), "error");
    return;
  }

  const lewati = isi.length - data.length;
  const form = document.getElementById("form-impor");
  if (form) form.querySelectorAll("input, select, button").forEach((x) => (x.disabled = true));
  toast(t("jemaat.importDoing").replace("[N]", String(data.length)));

  const muatUlang = async () => {
    await sinkronRingkasan();
    await muatKonfigurasi();
    await muatData();
    gambar();
  };

  let tersimpan = 0;
  try {
    for (const d of data) {
      await addDoc(collection(db, "jemaat"), d);
      tersimpan++;
    }
    await catatAudit(`Import jemaat`, "jemaat", imporNamaFile, `${tersimpan} baris`);
    closeModal();
    const pesan = t("jemaat.importDone").replace("[N]", String(tersimpan));
    toast(lewati ? `${pesan} ${t("jemaat.importSkip").replace("[N]", String(lewati))}` : pesan, "success");
    await muatUlang();
  } catch (err) {
    console.error(err);
    closeModal();
    toast(
      `${t("jemaat.importStopped")
        .replace("[N]", String(tersimpan))
        .replace("[M]", String(data.length))} ${friendlyError(err)}`,
      "error"
    );
    await muatUlang();
  }
}

/* ---------------- Modul ---------------- */

async function muat() {
  await muatKonfigurasi();
  await muatData();
}

const jemaat = {
  key: "jemaat",

  async mount(container) {
    el = container;
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;
    try {
      await muat();
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
    clearTimeout(cariTimmer);
    el = null;
  },
};

export default jemaat;
