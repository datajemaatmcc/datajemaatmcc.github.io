/* =========================================================
   absensi.js — MODUL 7: Absensi
   Checklist kehadiran jemaat per sesi ibadah (diisi PIC).

   Jadwal buka (WIB / Asia/Jakarta):
     Sabtu         17.00–00.00
     Minggu IBR 1  07.00–12.00
     Minggu IBR 2  16.00–22.00
   Di luar jendela itu form terkunci (tidak bisa diubah);
   perubahan data dilakukan manual lewat spreadsheet.

   Penyimpanan: Google Sheets — satu tab per bulan
   ("November 2026", dst). Endpoint API dipasang belakangan:
   sampai saat itu payload ditampung di antrean lokal
   (localStorage) supaya tidak hilang.
   ========================================================= */

import { db } from "./firebase-config.js";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite, currentUser } from "./auth.js";
import { esc, toast, friendlyError } from "./utils.js";
import { SPREADSHEET_ID, SA_KEY_FILE, MODE_UJI_COBA, SHEET_ENDPOINT } from "./sheets-config.js";

/* ---------------- Jadwal (WIB) ---------------- */

const OFFSET_WIB = 7 * 60; // menit

const JADWAL = [
  {
    key: "sabtu",
    labelKey: "abs.sabtu",
    hariKey: "abs.daySat",
    hari: 6, // 0 = Minggu ... 6 = Sabtu
    mulai: 17 * 60,
    selesai: 24 * 60,
    mulaiJam: "17.00",
    tutupJam: "00.00",
  },
  {
    key: "ibr1",
    labelKey: "abs.ibr1",
    hariKey: "abs.daySun",
    hari: 0,
    mulai: 7 * 60,
    selesai: 12 * 60,
    mulaiJam: "07.00",
    tutupJam: "12.00",
  },
  {
    key: "ibr2",
    labelKey: "abs.ibr2",
    hariKey: "abs.daySun",
    hari: 0,
    mulai: 16 * 60,
    selesai: 22 * 60,
    mulaiJam: "16.00",
    tutupJam: "22.00",
  },
];

/** Kolom sheet bulanan (format yang dikirim ke Google Sheets). */
const HEADERS = ["Tanggal", "Sesi", "Waktu", "PIC", "Nama", "Wilayah", "No. HP", "Status"];

const KUNCI_ANTREAN = "cms_absen_antrean";
const KUNCI_TERAKHIR = "cms_absen_terakhir";

/* ---------------- Waktu (WIB) ---------------- */

const pad = (n) => String(n).padStart(2, "0");

/**
 * Date berisi komponen WIB pada field UTC-nya (pakai getUTC* untuk membaca).
 * Dip-shift +7 jam tanpa melibatkan zona waktu perangkat, sehingga kebal
 * perubahan zona (DST) yang bisa melesetkan jam per hitungan biasa.
 */
function wibNow(d = new Date()) {
  return new Date(d.getTime() + OFFSET_WIB * 60000);
}

const tanggalISO = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const jamMenit = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** Nama tab sheet per bulan, contoh "November 2026" (selalu format ID). */
function namaSheet(d) {
  // `d` Date hasil wibNow: komponen WIB ada di field UTC.
  return new Intl.DateTimeFormat("id-ID", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** Jendela jadwal ASLI yang sedang terbuka (tanpa mode uji), atau null. */
function jadwalNyata(now = new Date()) {
  const w = wibNow(now);
  const menit = w.getUTCHours() * 60 + w.getUTCMinutes();
  return JADWAL.find(
    (j) => j.hari === w.getUTCDay() && menit >= j.mulai && menit < j.selesai
  ) || null;
}

/**
 * Jendela yang sedang terbuka sekarang, atau null.
 * MODE_UJI_COBA = true → jadwal diabaikan dan sesi terdekat selalu dipakai,
 * supaya form bisa dicoba kapan saja. Tabel jadwal tetap memakai
 * jadwalNyata() supaya status "Dibuka/Terkunci" di tabel tetap jujur.
 */
function sesiSaatIni(now = new Date()) {
  const w = wibNow(now);
  const menit = w.getUTCHours() * 60 + w.getUTCMinutes();
  const jadwal = jadwalNyata(now);
  if (jadwal) {
    return { jadwal, tanggal: w, sisaDetik: (jadwal.selesai - menit) * 60 - w.getUTCSeconds() };
  }
  if (!MODE_UJI_COBA) return null;
  const b = sesiBerikutnya(now);
  if (!b) return null;
  return { jadwal: b.jadwal, tanggal: w, sisaDetik: null, uji: true };
}

/** Jendela terdekat setelah sekarang (untuk panel "terkunci"). */
function sesiBerikutnya(now = new Date()) {
  for (let i = 0; i < 8; i++) {
    const w = wibNow(new Date(now.getTime() + i * 86400000));
    const menit = w.getUTCHours() * 60 + w.getUTCMinutes();
    for (const j of JADWAL) {
      if (j.hari !== w.getUTCDay()) continue;
      if (i > 0 || j.mulai > menit) return { jadwal: j, hariLagi: i };
    }
  }
  return null;
}

function fmtSisa(detik) {
  const s = Math.max(0, Math.floor(detik));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/* ---------------- State ---------------- */

const state = {
  jemaat: [],
  pilih: new Set(),
  q: "",
  muat: false,
  galat: "",
  terkirim: null, // { jam, jumlah } — kiriman terakhir pada sesi berjalan
};

let el = null;
let timer = null;
let terbuka = null; // jejak status jendela untuk deteksi perubahan

const namaPic = () => (currentUser && (currentUser.nama || currentUser.email)) || "-";
const kunciSesi = (sesi) => `${tanggalISO(sesi.tanggal)}|${sesi.jadwal.key}`;

/* ---------------- Antrean pengiriman ---------------- */

function bacaJSON(kunci) {
  try {
    return JSON.parse(localStorage.getItem(kunci) || "[]");
  } catch {
    return [];
  }
}

/** Kunci service account (diambil sekali, disimpan di memori). */
let saCache = null;
let tokenCache = null;

async function muatKunciSA() {
  if (saCache) return saCache;
  const res = await fetch(`./${SA_KEY_FILE}`, { cache: "no-store" });
  if (res.status === 404) {
    // Hosting statis (GitHub Pages) tidak memuat berkas kunci — itu disengaja.
    throw new Error(t("abs.keyMissing"));
  }
  if (!res.ok) {
    throw new Error(`Berkas kunci Google (${SA_KEY_FILE}) tidak dapat dibaca (${res.status}).`);
  }
  saCache = await res.json();
  return saCache;
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemKeArrayBuffer(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

/**
 * Tukar JWT (RS256, ditandatangani kunci privat service account) → token akses.
 * Dipanggil saat token kosong/kadaluarsa; disimpan ±1 jam.
 */
async function ambilToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.sampai > now + 60) return tokenCache.access_token;

  // Web Crypto hanya tersedia di secure context (https / localhost).
  // Di alamat lain (http://IP-jaringan, file://) penandatanganan mustahil —
  // beri pesan yang jelas, bukan galat "reading 'importKey'".
  if (typeof crypto === "undefined" || !crypto.subtle) {
    const ada = typeof crypto !== "undefined" && !!crypto.subtle;
    // Bawa kondisi sebenarnya pada pesan supaya langsung terbaca penyebabnya:
    // alamat terbuka, status secure context, dan status Web Crypto.
    console.error("[absensi] Web Crypto tidak tersedia:", {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      cryptoSubtle: ada,
      userAgent: navigator.userAgent,
    });
    throw new Error(
      `${t("abs.insecureCtx")} (dibuka dari ${location.origin || "-"} · secure context: ${
        window.isSecureContext ? "ya" : "tidak"
      } · Web Crypto: ${ada ? "ada" : "tidak ada"})`
    );
  }

  const sa = await muatKunciSA();
  const teks = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${teks({ alg: "RS256", typ: "JWT" })}.${teks({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const kunci = await crypto.subtle.importKey(
    "pkcs8",
    pemKeArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const tanda = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    kunci,
    new TextEncoder().encode(data)
  );

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${data}.${b64url(tanda)}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token Google gagal (${res.status}): ${json.error_description || json.error || "-"}`
    );
  }
  tokenCache = { access_token: json.access_token, sampai: now + Number(json.expires_in || 3600) };
  return tokenCache.access_token;
}

/** Panggil Sheets API v4 dengan Bearer token; lempar Error berisi pesan Google. */
async function panggilSheets(path, init = {}) {
  const tok = await ambilToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const pesan = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    throw new Error(pesan);
  }
  return json;
}

/** Buat tab bulan bila belum ada, lengkap dengan baris judul kolom. */
async function pastikanTab(nama) {
  const meta = await panggilSheets(`spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(title)`);
  const ada = (meta.sheets || []).some((s) => s.properties && s.properties.title === nama);
  if (ada) return;

  await panggilSheets(`spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: nama } } }] }),
  });
  await panggilSheets(
    `spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`'${nama}'!A1`)}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [HEADERS] }),
    }
  );
}

/**
 * Teruskan absen ke Google Sheets (append ke tab bulan berjalan).
 * SPREADSHEET_ID belum diisi → payload disimpan di antrean lokal
 * supaya tidak hilang, dan menunggu pengaturan.
 */
function antrePayload(payload) {
  const antre = bacaJSON(KUNCI_ANTREAN);
  antre.push(payload);
  try {
    localStorage.setItem(KUNCI_ANTREAN, JSON.stringify(antre.slice(-20)));
  } catch {
    /* kuota penuh — biarkan */
  }
}

/** Terjemahkan galat Google menjadi pesan yang mudah dipahami. */
function pesanSheets(err) {
  const m = friendlyError(err);
  if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED/i.test(m)) {
    return t("abs.apiDisabled");
  }
  if (/Requested entity was not found/i.test(m)) {
    return t("abs.sheetNoAccess");
  }
  return m;
}

/** Tulis payload ke sheet: pastikan tab ada, lalu append baris. */
async function tulisKeSheet(payload) {
  // Melalui proxy (SHEET_ENDPOINT): kunci service account tinggal di server,
  // peramban tidak pernah menyentuhnya — aman untuk hosting statis.
  if (SHEET_ENDPOINT) {
    const res = await fetch(SHEET_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return;
  }
  await pastikanTab(payload.sheet);
  await panggilSheets(
    `spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(
      `'${payload.sheet}'!A1`
    )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: payload.rows }),
    }
  );
}

/**
 * Kirim ulang isi antrean lokal (kiriman yang gagal / belum terkonfigurasi).
 * @returns {Promise<number>} jumlah kiriman tertunda yang berhasil terkirim
 */
async function flushAntrean() {
  const antre = bacaJSON(KUNCI_ANTREAN);
  if (!antre.length || (!SHEET_ENDPOINT && !SPREADSHEET_ID)) return 0;
  const tersisa = [];
  let sukses = 0;
  for (const p of antre) {
    try {
      await tulisKeSheet(p);
      sukses++;
    } catch {
      tersisa.push(p);
    }
  }
  try {
    if (tersisa.length) localStorage.setItem(KUNCI_ANTREAN, JSON.stringify(tersisa));
    else localStorage.removeItem(KUNCI_ANTREAN);
  } catch {
    /* abaikan */
  }
  if (sukses) console.info(`[absensi] ${sukses} kiriman tertunda terkirim ulang`);
  return sukses;
}

async function kirimKeSheet(payload) {
  if (!SHEET_ENDPOINT && !SPREADSHEET_ID) {
    antrePayload(payload);
    console.info("[absensi] SPREADSHEET_ID belum diisi — payload diantrekan:", payload);
    return { status: "antre" };
  }

  try {
    await tulisKeSheet(payload);
    return { status: "terkirim" };
  } catch (err) {
    // Gagal terkirim → simpan dulu di antrean supaya tidak hilang.
    antrePayload(payload);
    console.warn("[absensi] kirim gagal, masuk antrean:", err);
    throw err;
  }
}

function catatTerakhir(kunci, jam, jumlah) {
  try {
    const semua = JSON.parse(localStorage.getItem(KUNCI_TERAKHIR) || "{}");
    semua[kunci] = { jam, jumlah };
    localStorage.setItem(KUNCI_TERAKHIR, JSON.stringify(semua));
  } catch {
    /* abaikan */
  }
  state.terkirim = { jam, jumlah };
}

function ambilTerakhir(kunci) {
  try {
    return JSON.parse(localStorage.getItem(KUNCI_TERAKHIR) || "{}")[kunci] || null;
  } catch {
    return null;
  }
}

/* ---------------- Data ---------------- */

async function muatJemaat() {
  state.muat = true;
  state.galat = "";
  gambar();
  try {
    const snap = await getDocs(query(collection(db, "jemaat"), orderBy("nama")));
    state.jemaat = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (err) {
    console.warn("Gagal memuat data jemaat:", err);
    state.galat = friendlyError(err);
    state.jemaat = [];
  } finally {
    state.muat = false;
    gambar();
  }
}

/* ---------------- Tampilan ---------------- */

function jadwalTabel(jadwalAktif) {
  return JADWAL.map((j) => {
    const aktif = jadwalAktif && jadwalAktif.key === j.key;
    return `<tr>
      <td><b>${t(j.labelKey)}</b></td>
      <td>${t(j.hariKey)}</td>
      <td>${j.mulaiJam}–${j.tutupJam}</td>
      <td><span class="badge ${aktif ? "badge-green" : "badge-gray"}">${
        aktif ? t("abs.open") : t("abs.closed")
      }</span></td>
    </tr>`;
  }).join("");
}

function tampilanList() {
  if (state.muat) return `<p class="muted">${t("common.loading")}</p>`;
  if (state.galat) return `<p class="muted">${esc(state.galat)}</p>`;
  const q = state.q.trim().toLowerCase();
  const rows = state.jemaat.filter((x) => !q || String(x.nama || "").toLowerCase().includes(q));
  if (!rows.length) {
    return `<p class="muted">${state.jemaat.length ? t("common.empty") : t("abs.empty")}</p>`;
  }
  return rows
    .map(
      (x) => `<label class="abs-item">
        <input type="checkbox" data-id="${esc(x.id)}" ${
          state.pilih.has(x.id) ? "checked" : ""
        }>
        <span class="nm">${esc(x.nama || "-")}</span>
        <span class="muted">${esc(x.wilayah || "")}</span>
      </label>`
    )
    .join("");
}

function teksHitungMundur(sesi) {
  if (sesi) {
    if (sesi.sisaDetik === null) return `🧪 ${t("abs.testMode")}`;
    return `${t("abs.openUntil")} ${sesi.jadwal.tutupJam} · <b>${fmtSisa(sesi.sisaDetik)}</b>`;
  }
  const b = sesiBerikutnya();
  if (!b) return "";
  const hari = t(b.jadwal.hariKey); // "Sabtu" / "Minggu"
  // Sesi hanya disebut bila tidak sama dengan nama harinya (mis. IBR 2).
  const perluSesi = t(b.jadwal.labelKey) !== hari;
  const relatif =
    b.hariLagi === 0
      ? ` (${t("abs.today")})`
      : b.hariLagi === 1
      ? ` (${t("abs.tomorrow")})`
      : "";
  return `${t("abs.next")} ${hari} ${b.jadwal.mulaiJam}${
    perluSesi ? ` · ${t(b.jadwal.labelKey)}` : ""
  }${relatif}`;
}

function gambar() {
  if (!el) return;
  const bolehTulis = canWrite("absensi");
  const sesi = sesiSaatIni();
  const jadwalBuka = jadwalNyata(); // untuk tabel: status jadwal asli
  terbuka = sesi ? sesi.jadwal.key : null;

  let pengingat = "";
  if (sesi) {
    const tdk = ambilTerakhir(kunciSesi(sesi));
    if (tdk) {
      pengingat = `<p class="muted" style="margin:6px 0 0">${esc(
        t("abs.lastSent").replace("[JAM]", tdk.jam).replace("[N]", String(tdk.jumlah))
      )}</p>`;
    }
  }

  const sesiKini = sesi
    ? `${t(sesi.jadwal.labelKey)} · ${sesi.jadwal.mulaiJam}–${sesi.jadwal.tutupJam}`
    : t("abs.closedSub");

  const konten = !sesi
    ? `<div class="abs-lock">
         <span>🔒</span>
         <div>
           <b>${t("abs.closedTitle")}</b>
           <p class="muted" style="margin:4px 0 0">${t("abs.lockNote")}</p>
         </div>
       </div>`
    : !bolehTulis
    ? `<p class="muted" style="margin:0">${t("abs.readonly")}</p>`
    : `<div class="card">
         <div class="row" style="flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px">
           <span class="badge badge-green">✅ ${t("abs.openTitle")}</span>
           <b>${t(sesi.jadwal.labelKey)}</b>
           <span class="muted">${t("abs.sheet")}: ${esc(namaSheet(sesi.tanggal))}</span>
         </div>
         <p class="muted" style="margin:0 0 12px">
           ${t("abs.pic")}: <b>${esc(namaPic())}</b>
         </p>
         <div class="toolbar">
           <input id="abs-q" class="grow" type="search" value="${esc(state.q)}"
                  placeholder="${esc(t("abs.searchPh"))}">
           <span class="muted" id="abs-count">${t("abs.selectCount").replace(
             "[N]",
             String(state.pilih.size)
           )}</span>
           <button class="btn btn-outline btn-sm" data-act="semua">${t("abs.selectAll")}</button>
           <button class="btn btn-outline btn-sm" data-act="kosong">${t("abs.clear")}</button>
         </div>
         <div class="abs-list" id="abs-list">${tampilanList()}</div>
         ${pengingat}
         <div class="modal-foot">
           <button class="btn btn-primary" data-act="kirim" ${
             state.pilih.size ? "" : "disabled"
           }>📤 ${t("abs.submit")}</button>
         </div>
       </div>`;

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("abs.subtitle")}</p>
      <button class="btn btn-outline btn-sm" data-act="refresh">🔄 ${t("action.refresh")}</button>
    </div>

    <div class="card mb">
      <div class="row row-between" style="flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <div class="row" style="gap:8px;align-items:center">
          <span class="badge ${sesi ? "badge-green" : "badge-gray"}">${
            sesi ? "🔓 " + t("abs.openTitle") : "🔒 " + t("abs.closedTitle")
          }</span>
          <b>${sesiKini}</b>
        </div>
        <div class="muted" id="abs-countdown">${teksHitungMundur(sesi)}</div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>${t("abs.hSesi")}</th>
              <th>${t("abs.hHari")}</th>
              <th>${t("abs.hJam")}</th>
              <th>${t("abs.hStatus")}</th>
            </tr>
          </thead>
          <tbody>${jadwalTabel(jadwalBuka)}</tbody>
        </table>
      </div>
    </div>

    ${konten}`;

  pasangListener(sesi);
}

/* ---------------- Interaksi ---------------- */

function pasangListener(sesi) {
  el.querySelector('[data-act="refresh"]')?.addEventListener("click", muatJemaat);

  const q = el.querySelector("#abs-q");
  if (q) {
    q.addEventListener("input", () => {
      state.q = q.value;
      const list = el.querySelector("#abs-list");
      if (list) list.innerHTML = tampilanList();
    });
  }

  el.querySelector("#abs-list")?.addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    if (cb.checked) state.pilih.add(cb.dataset.id);
    else state.pilih.delete(cb.dataset.id);
    perbaruiHitung();
  });

  el.querySelector('[data-act="semua"]')?.addEventListener("click", () => {
    const q2 = state.q.trim().toLowerCase();
    state.jemaat
      .filter((x) => !q2 || String(x.nama || "").toLowerCase().includes(q2))
      .forEach((x) => state.pilih.add(x.id));
    gambar();
  });

  el.querySelector('[data-act="kosong"]')?.addEventListener("click", () => {
    state.pilih.clear();
    gambar();
  });

  el.querySelector('[data-act="kirim"]')?.addEventListener("click", () => kirim(sesi));
}

function perbaruiHitung() {
  const c = el.querySelector("#abs-count");
  if (c) c.textContent = t("abs.selectCount").replace("[N]", String(state.pilih.size));
  const btn = el.querySelector('[data-act="kirim"]');
  if (btn) btn.disabled = state.pilih.size === 0;
}

/* ---------------- Kirim ---------------- */

async function kirim(sesi) {
  if (!sesi) {
    toast(t("abs.closedToast"), "error");
    gambar();
    return;
  }
  const hadir = state.jemaat.filter((x) => state.pilih.has(x.id));
  if (!hadir.length) {
    toast(t("abs.noSelection"), "error");
    return;
  }

  const w = sesi.tanggal;
  const tgl = tanggalISO(w);
  const jam = jamMenit(w);
  const sesiLabel = t(sesi.jadwal.labelKey);
  const pic = namaPic();
  const payload = {
    sheet: namaSheet(w),
    header: HEADERS,
    rows: hadir.map((x) => [
      tgl,
      sesiLabel,
      jam,
      pic,
      x.nama || "",
      x.wilayah || "",
      x.noHp || "",
      "Hadir",
    ]),
  };

  try {
    const hasil = await kirimKeSheet(payload);
    catatTerakhir(kunciSesi(sesi), jam, hadir.length);
    toast(t("abs.saved").replace("[N]", String(hadir.length)));
    if (hasil.status === "antre") {
      toast(t("abs.pending"));
    } else {
      const tertunda = await flushAntrean();
      if (tertunda) toast(t("abs.flushed").replace("[N]", String(tertunda)));
    }
    gambar();
  } catch (err) {
    console.error("Kirim absen gagal:", err);
    toast(`${t("abs.failed")} ${pesanSheets(err)}`, "error");
    toast(t("abs.queuedOnFail"), "error");
  }
}

/* ---------------- Deteksi tutup/jeda ---------------- */

function tick() {
  const sesi = sesiSaatIni();
  const status = sesi ? sesi.jadwal.key : null;
  if (status !== terbuka) {
    gambar();
    if (status === null) toast(t("abs.closedToast"));
    return;
  }
  const box = el && el.querySelector("#abs-countdown");
  if (box && sesi) box.innerHTML = teksHitungMundur(sesi);
}

/* ---------------- Modul ---------------- */

const absensi = {
  key: "absensi",

  async mount(container) {
    el = container;
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;
    clearInterval(timer);
    terbuka = null;
    try {
      await muatJemaat();
    } catch (err) {
      console.error(err);
      el.innerHTML = `<div class="card"><div class="empty-state">
        <span class="empty-ico">⚠️</span><b>${t("common.error")}</b>
        <span>${esc(friendlyError(err))}</span></div></div>`;
      return;
    }
    timer = setInterval(tick, 1000);
  },

  unmount() {
    clearInterval(timer);
    timer = null;
    el = null;
  },
};

export default absensi;
