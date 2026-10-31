/* =========================================================
   pengaturan.js — MODUL 6: Pengaturan (4 tab)
   Tab 1 Profil      : identitas gereja, struktur pengurus,
                       template pesan WA, batas kategori umur
   Tab 2 Kategori    : daftar chip kategori keuangan/inventaris/wilayah
   Tab 3 User        : manajemen user (hanya Admin)
   Tab 4 Audit Trail : 50 aksi terakhir dari `audit_log`

   Semua tab membaca & menulis `pengaturan/*` (rules: baca semua
   role aktif, tulis hanya Admin — lihat Firestore Rules).
   ========================================================= */

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { t } from "./i18n.js";
import { canWrite, canManageUsers } from "./auth.js";
import {
  esc,
  toast,
  dateTime,
  cleanText,
  cleanNumber,
  openModal,
  closeModal,
  confirmDialog,
  friendlyError,
} from "./utils.js";
import { catatAudit, ambilPengaturan, hitungRingkasanJemaat } from "./store.js";

const state = {
  tab: "profil", // profil | kategori | user | audit
  profil: null,
  kategori: { keuangan: [], inventaris: [], wilayah: [] },
  users: [],
  audit: [],
};

let el = null;

/* ---------------- Muat data ---------------- */

async function muatProfilDanKategori() {
  const [profil, kategori] = await Promise.all([
    ambilPengaturan("profil"),
    ambilPengaturan("kategori"),
  ]);
  state.profil = profil;
  state.kategori = {
    keuangan: (kategori && kategori.keuangan) || [],
    inventaris: (kategori && kategori.inventaris) || [],
    wilayah: (kategori && kategori.wilayah) || [],
  };
}

async function muatUsers() {
  const snap = await getDocs(query(collection(db, "users"), limit(100)));
  state.users = snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));
}

async function muatAudit() {
  const snap = await getDocs(query(collection(db, "audit_log"), orderBy("waktu", "desc"), limit(50)));
  state.audit = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ---------------- Tampilan ---------------- */

function tabs() {
  const daftar = [
    ["profil", "⚙️ " + t("set.tabProfile")],
    ["kategori", "🏷️ " + t("set.tabCategories")],
    ["user", "👤 " + t("set.tabUsers")],
    ["audit", "🕘 " + t("set.tabAudit")],
  ];
  return `<div class="tabs" id="set-tabs">
    ${daftar
      .map(
        ([k, l]) =>
          `<button class="tab-btn ${state.tab === k ? "active" : ""}" data-tab="${k}">${l}</button>`
      )
      .join("")}
  </div>`;
}

function panelProfil() {
  const p = state.profil || {};
  const s = p.struktur || {};
  const b = p.batasUmur || {};
  const boleh = canWrite("pengaturan");

  return `
    <form id="form-profil" ${boleh ? "" : "inert"}>
      <div class="form-grid">
        <label class="field full"><span>${t("set.churchName")} *</span>
          <input name="namaGereja" maxlength="120" value="${esc(p.namaGereja || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field full"><span>${t("set.logoUrl")}</span>
          <input name="logoUrl" maxlength="500" placeholder="https://…" value="${esc(p.logoUrl || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field full"><span>${t("set.address")}</span>
          <input name="alamat" maxlength="200" value="${esc(p.alamat || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field full"><span>${t("set.description")}</span>
          <textarea name="deskripsi" rows="2" maxlength="400" ${boleh ? "" : "disabled"}>${esc(p.deskripsi || "")}</textarea></label>

        <label class="field"><span>${t("set.pastor")}</span>
          <input name="gembala" maxlength="80" value="${esc(s.gembala || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.chairman")}</span>
          <input name="ketuaMajelis" maxlength="80" value="${esc(s.ketuaMajelis || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.treasurer")}</span>
          <input name="bendahara" maxlength="80" value="${esc(s.bendahara || "")}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.ageLimits")}</span>
          <input name="batasLansia" type="number" min="40" max="120" value="${b.lansia ?? 60}" ${boleh ? "" : "disabled"} /></label>

        <label class="field"><span>${t("set.ageChild")}</span>
          <input name="batasAnak" type="number" min="1" max="20" value="${b.anak ?? 12}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.ageYouth")}</span>
          <input name="batasRemaja" type="number" min="2" max="30" value="${b.remaja ?? 18}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.ageAdult")}</span>
          <input name="batasPemuda" type="number" min="3" max="60" value="${b.pemuda ?? 30}" ${boleh ? "" : "disabled"} /></label>
        <label class="field"><span>${t("set.ageSeniorNote")}</span>
          <span class="muted">${t("set.ageNote")}</span></label>

        <label class="field full"><span>${t("set.msgBirthday")}</span>
          <textarea name="templateUlangTahun" rows="3" maxlength="600" placeholder="${esc(t("set.msgPlaceholder"))}" ${boleh ? "" : "disabled"}>${esc(p.templateUlangTahun || "")}</textarea></label>
        <label class="field full"><span>${t("set.msgAnniversary")}</span>
          <textarea name="templateAnniversary" rows="3" maxlength="600" placeholder="${esc(t("set.msgPlaceholder"))}" ${boleh ? "" : "disabled"}>${esc(p.templateAnniversary || "")}</textarea></label>
      </div>
      ${boleh
        ? `<div class="modal-foot">
             <button type="submit" class="btn btn-primary">💾 ${t("action.save")}</button>
           </div>`
        : `<p class="muted">${t("set.readonly")}</p>`}
    </form>`;
}

function editorChip(jenis, judul, hint) {
  const daftar = state.kategori[jenis] || [];
  return `
    <div class="card mb">
      <div class="card-title">${esc(judul)}</div>
      <p class="card-sub">${esc(hint)}</p>
      <div class="row mb" style="gap:8px">
        ${daftar.length
          ? daftar
              .map(
                (v, i) =>
                  `<span class="badge badge-blue" style="padding:6px 10px">${esc(v)}
                     <button type="button" class="chip-x" data-jenis="${esc(jenis)}" data-i="${i}" title="Hapus" aria-label="Hapus">✕</button>
                   </span>`
              )
              .join("")
          : `<span class="muted">${t("common.empty")}</span>`}
      </div>
      <div class="row">
        <input class="form-control" style="max-width:260px" data-add="${esc(jenis)}" maxlength="60"
               placeholder="${esc(t("set.catAddPh"))}" />
        <button type="button" class="btn btn-outline btn-sm" data-addbtn="${esc(jenis)}">＋ ${t("action.add")}</button>
      </div>
    </div>`;
}

function panelKategori() {
  const boleh = canWrite("pengaturan");
  if (!boleh) return `<p class="muted">${t("set.readonly")}</p>`;
  return `
    ${editorChip("keuangan", t("set.catFinance"), t("set.catFinanceHint"))}
    ${editorChip("inventaris", t("set.catInventory"), t("set.catInventoryHint"))}
    ${editorChip("wilayah", t("set.catWard"), t("set.catWardHint"))}
    <div class="row row-between">
      <span class="muted">${t("set.catHint")}</span>
      <button type="button" class="btn btn-primary" id="set-save-kategori">💾 ${t("action.save")}</button>
    </div>`;
}

function panelUser() {
  if (!canManageUsers()) {
    return `<div class="alert alert-warn">${t("set.userNoAccess")}</div>`;
  }
  return `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("set.userHint")}</p>
      <button type="button" class="btn btn-primary btn-sm" id="set-add-user">＋ ${t("set.addUser")}</button>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>${t("set.colName")}</th>
            <th>${t("set.colEmail")}</th>
            <th>${t("set.colRole")}</th>
            <th>${t("set.colStatus")}</th>
            <th>UID</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${state.users.length === 0
            ? `<tr><td colspan="6"><div class="empty-state">
                 <span class="empty-ico">👤</span><b>${t("set.userEmpty")}</b>
                 <span>${t("set.userHint")}</span></div></td></tr>`
            : state.users
                .map(
                  (u) => `
                  <tr>
                    <td><b>${esc(u.nama || "—")}</b></td>
                    <td>${esc(u.email || "—")}</td>
                    <td><span class="badge badge-purple">${esc(u.role || "Viewer")}</span></td>
                    <td><span class="badge ${u.aktif === false ? "badge-gray" : "badge-green"}">${u.aktif === false ? t("common.inactive") : t("common.active")}</span></td>
                    <td class="muted">${esc(u.uid)}</td>
                    <td class="actions">
                      <button class="btn btn-outline btn-sm" data-act="edit-user" data-uid="${esc(u.uid)}">✏️</button>
                      <button class="btn btn-outline btn-sm" data-act="del-user" data-uid="${esc(u.uid)}">🗑️</button>
                    </td>
                  </tr>`
                )
                .join("")}
        </tbody>
      </table>
    </div>`;
}

function panelAudit() {
  return `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("set.auditHint")}</p>
      <button type="button" class="btn btn-outline btn-sm" id="set-refresh-audit">🔄 ${t("action.refresh")}</button>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>${t("set.auditTime")}</th>
            <th>${t("set.auditUser")}</th>
            <th>${t("set.auditAction")}</th>
            <th>${t("set.auditTarget")}</th>
            <th>${t("set.auditDetail")}</th>
          </tr>
        </thead>
        <tbody>
          ${state.audit.length === 0
            ? `<tr><td colspan="5"><div class="empty-state">
                 <span class="empty-ico">🕘</span><b>${t("set.auditEmpty")}</b>
                 <span>${t("set.auditEmptyHint")}</span></div></td></tr>`
            : state.audit
                .map(
                  (a) => `
                  <tr>
                    <td>${dateTime(a.waktu)}</td>
                    <td>${esc(a.userName || "—")}</td>
                    <td><span class="badge badge-blue">${esc(a.aksi || "—")}</span></td>
                    <td class="muted">${esc(a.koleksi || "—")}</td>
                    <td>${esc(a.detail || a.docId || "—")}</td>
                  </tr>`
                )
                .join("")}
        </tbody>
      </table>
    </div>`;
}

function gambar() {
  const isi =
    state.tab === "profil"
      ? panelProfil()
      : state.tab === "kategori"
      ? panelKategori()
      : state.tab === "user"
      ? panelUser()
      : panelAudit();

  el.innerHTML = `
    <div class="row row-between mb">
      <p class="muted" style="margin:0">${t("set.subtitle")}</p>
      <button class="btn btn-outline btn-sm" data-act="refresh">🔄 ${t("action.refresh")}</button>
    </div>
    <div class="card">
      ${tabs()}
      <div class="tab-panel" data-panel="${state.tab}">${isi}</div>
    </div>`;

  pasangListener();
}

function pasangListener() {
  el.querySelectorAll("#set-tabs .tab-btn").forEach((b) => {
    b.onclick = async () => {
      state.tab = b.dataset.tab;
      if (state.tab === "user" && canManageUsers() && !state.users.length) await muatUsers().catch(() => {});
      if (state.tab === "audit" && !state.audit.length) await muatAudit().catch(() => {});
      gambar();
    };
  });

  const refresh = el.querySelector('[data-act="refresh"]');
  if (refresh)
    refresh.onclick = async () => {
      await muatProfilDanKategori().catch(() => {});
      if (state.tab === "user") await muatUsers().catch(() => {});
      if (state.tab === "audit") await muatAudit().catch(() => {});
      gambar();
    };

  // --- Tab profil
  const form = el.querySelector("#form-profil");
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    simpanProfil(new FormData(form));
  };

  // --- Tab kategori
  el.querySelectorAll("[data-addbtn]").forEach((b) => {
    b.onclick = () => tambahChip(b.dataset.addbtn);
  });
  el.querySelectorAll("[data-add]").forEach((inp) => {
    inp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        tambahChip(inp.dataset.add);
      }
    };
  });
  el.querySelectorAll(".chip-x").forEach((b) => {
    b.onclick = () => {
      const { jenis } = b.dataset;
      state.kategori[jenis].splice(Number(b.dataset.i), 1);
      gambar();
    };
  });
  const simpanKat = el.querySelector("#set-save-kategori");
  if (simpanKat) simpanKat.onclick = simpanKategori;

  // --- Tab user
  const addUser = el.querySelector("#set-add-user");
  if (addUser) addUser.onclick = () => formUser(null);
  el.querySelectorAll('[data-act="edit-user"]').forEach((b) => {
    b.onclick = () => {
      const u = state.users.find((x) => x.uid === b.dataset.uid);
      if (u) formUser(u);
    };
  });
  el.querySelectorAll('[data-act="del-user"]').forEach((b) => {
    b.onclick = () => {
      const u = state.users.find((x) => x.uid === b.dataset.uid);
      if (u) hapusUser(u);
    };
  });

  // --- Tab audit
  const refAudit = el.querySelector("#set-refresh-audit");
  if (refAudit)
    refAudit.onclick = async () => {
      await muatAudit().catch(() => {});
      gambar();
    };
}

/* ---------------- Aksi: profil ---------------- */

async function simpanProfil(fd) {
  const namaGereja = cleanText(fd.get("namaGereja"), 120);
  if (!namaGereja) {
    toast(t("set.churchNameRequired"), "error");
    return;
  }
  const data = {
    namaGereja,
    logoUrl: cleanText(fd.get("logoUrl"), 500),
    alamat: cleanText(fd.get("alamat"), 200),
    deskripsi: cleanText(fd.get("deskripsi"), 400),
    struktur: {
      gembala: cleanText(fd.get("gembala"), 80),
      ketuaMajelis: cleanText(fd.get("ketuaMajelis"), 80),
      bendahara: cleanText(fd.get("bendahara"), 80),
    },
    batasUmur: {
      anak: cleanNumber(fd.get("batasAnak")) ?? 12,
      remaja: cleanNumber(fd.get("batasRemaja")) ?? 18,
      pemuda: cleanNumber(fd.get("batasPemuda")) ?? 30,
      lansia: cleanNumber(fd.get("batasLansia")) ?? 60,
    },
    templateUlangTahun: cleanText(fd.get("templateUlangTahun"), 600),
    templateAnniversary: cleanText(fd.get("templateAnniversary"), 600),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, "pengaturan", "profil"), data, { merge: true });
    await catatAudit("Ubah profil gereja", "pengaturan/profil", "profil", namaGereja);
    state.profil = { ...(state.profil || {}), ...data };
    toast(t("set.profileSaved"), "success");
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Aksi: kategori ---------------- */

function tambahChip(jenis) {
  const inp = el.querySelector(`[data-add="${jenis}"]`);
  if (!inp) return;
  const nilai = cleanText(inp.value, 60);
  if (!nilai) return;
  if (state.kategori[jenis].includes(nilai)) {
    toast(t("set.catDuplicate"), "error");
    return;
  }
  state.kategori[jenis].push(nilai);
  gambar();
}

async function simpanKategori() {
  try {
    await setDoc(doc(db, "pengaturan", "kategori"), { ...state.kategori }, { merge: true });
    await catatAudit(
      "Ubah kategori sistem",
      "pengaturan/kategori",
      "kategori",
      Object.entries(state.kategori)
        .map(([k, v]) => `${k}: ${v.length}`)
        .join(", ")
    );
    toast(t("set.catsSaved"), "success");
    // Wilayah baru bisa mengubah ringkasan per-wilayah → hitung ulang.
    try {
      await hitungRingkasanJemaat();
    } catch (e) {
      console.warn("Ringkasan jemaat tidak bisa dihitung ulang:", e);
    }
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Aksi: user ---------------- */

function formUser(row) {
  const u = row || {};
  const opsiRole = ["Admin", "Bendahara", "Sekretaris", "Viewer"]
    .map((r) => `<option value="${r}" ${(u.role || "Viewer") === r ? "selected" : ""}>${r}</option>`)
    .join("");

  const html = `
    <form id="form-user">
      <div class="form-grid">
        <label class="field full"><span>UID (Firebase Authentication) *</span>
          <input name="uid" required maxlength="128" value="${esc(u.uid || "")}" ${row ? "readonly" : ""} /></label>
        <label class="field"><span>${t("set.colName")} *</span>
          <input name="nama" required maxlength="80" value="${esc(u.nama || "")}" /></label>
        <label class="field"><span>${t("set.colEmail")} *</span>
          <input name="email" type="email" required maxlength="120" value="${esc(u.email || "")}" /></label>
        <label class="field"><span>${t("set.colRole")}</span>
          <select name="role">${opsiRole}</select></label>
        <label class="field"><span>${t("common.active")}</span>
          <select name="aktif">
            <option value="true" ${u.aktif !== false ? "selected" : ""}>${t("common.active")}</option>
            <option value="false" ${u.aktif === false ? "selected" : ""}>${t("common.inactive")}</option>
          </select></label>
      </div>
      <div class="alert alert-warn" style="margin-top:12px">${t("set.userHint")}</div>
      <div class="modal-foot">
        <button type="button" class="btn btn-outline" data-act="batal">${t("action.cancel")}</button>
        <button type="submit" class="btn btn-primary">${t("action.save")}</button>
      </div>
    </form>`;

  openModal(row ? t("set.editUser") : t("set.addUser"), html, (fd) => simpanUser(fd, !!row));
  const batal = document.querySelector("#form-user [data-act='batal']");
  if (batal) batal.onclick = closeModal;
}

async function simpanUser(fd, isEdit) {
  const uid = cleanText(fd.get("uid"), 128);
  const nama = cleanText(fd.get("nama"), 80);
  const email = cleanText(fd.get("email"), 120);
  if (!uid || !nama || !email) {
    toast(t("set.userFormInvalid"), "error");
    return;
  }
  const data = {
    nama,
    email,
    role: ["Admin", "Bendahara", "Sekretaris", "Viewer"].includes(fd.get("role"))
      ? fd.get("role")
      : "Viewer",
    aktif: fd.get("aktif") !== "false",
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, "users", uid), data, { merge: true });
    await catatAudit(isEdit ? "Ubah user" : "Tambah user", "users", uid, `${nama} (${data.role})`);
    closeModal();
    toast(t("set.userSaved"), "success");
    await muatUsers();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

async function hapusUser(u) {
  const ok = await confirmDialog(t("set.confirmDeleteUser").replace("[NAMA]", u.nama || u.uid), {
    okLabel: t("action.delete"),
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "users", u.uid));
    await catatAudit("Hapus user", "users", u.uid, u.nama || "");
    toast(t("set.userDeleted"), "success");
    await muatUsers();
    gambar();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), "error");
  }
}

/* ---------------- Modul ---------------- */

const pengaturan = {
  key: "pengaturan",

  /** Dipanggil modul lain (mis. tombol Dashboard) untuk buka tab tertentu. */
  openTab(tab) {
    const peta = { profil: "profil", struktur: "profil", kategori: "kategori", user: "user", audit: "audit" };
    state.tab = peta[tab] || "profil";
    if (el) gambar();
  },

  async mount(container) {
    el = container;
    el.innerHTML = `<div class="card"><div class="empty-state">
      <span class="empty-ico">⏳</span><b>${t("common.loading")}</b></div></div>`;
    try {
      await muatProfilDanKategori();
      if (state.tab === "user" && canManageUsers()) await muatUsers().catch(() => {});
      if (state.tab === "audit") await muatAudit().catch(() => {});
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

export default pengaturan;
