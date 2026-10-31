/* =========================================================
   auth.js — login, sesi, profil user, dan batas peran (role)
   Semua halaman aplikasi wajib lewat sini.
   ========================================================= */

import { auth, db, IS_CONFIG_READY } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { esc, friendlyError, toast } from "./utils.js";

/** Profil user yang sedang login (disimpan setelah auth berhasil). */
export let currentUser = null;

/**
 * Hak akses per role (dipakai UI untuk menyembunyikan aksi terlarang;
 * pertahanan sesungguhnya ada di Firestore Security Rules).
 * Semua angka = boleh baca. `write` = boleh menulis modul tersebut.
 */
export const PERMISSIONS = {
  Admin: {
    read: ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"],
    write: ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"],
    manageUsers: true,
  },
  Bendahara: {
    read: ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"],
    write: ["keuangan"],
    manageUsers: false,
  },
  Sekretaris: {
    read: ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"],
    write: ["jemaat", "logistik", "absensi"],
    manageUsers: false,
  },
  Viewer: {
    read: ["dashboard", "jemaat", "keuangan", "logistik", "absensi", "laporan", "pengaturan"],
    write: [],
    manageUsers: false,
  },
};

/** Boleh modul ini dibaca oleh role aktif? */
export function canRead(module) {
  const r = currentUser && currentUser.role;
  const p = PERMISSIONS[r];
  return !!(p && p.read.includes(module));
}

/** Boleh modul ini ditulis oleh role aktif? */
export function canWrite(module) {
  const r = currentUser && currentUser.role;
  const p = PERMISSIONS[r];
  return !!(p && p.write.includes(module));
}

/** Boleh mengelola user? */
export function canManageUsers() {
  const r = currentUser && currentUser.role;
  const p = PERMISSIONS[r];
  return !!(p && p.manageUsers);
}

/**
 * Ambil profil user dari koleksi `users/{uid}`.
 * @returns {Promise<object|null>} null bila dokumen tidak ada
 */
export async function fetchUserProfile(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    return snap.exists() ? { uid: user.uid, ...snap.data() } : null;
  } catch (err) {
    // Koleksi users belum ada / rules menolak → biarkan penangan di pemanggil
    console.warn("Gagal membaca profil user:", err);
    return null;
  }
}

/** Masuk dengan email & kata sandi. Melempar Error bila gagal. */
export async function login(email, password) {
  if (!IS_CONFIG_READY) {
    throw new Error("Konfigurasi Firebase belum diisi (js/firebase-config.js).");
  }
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profile = await fetchUserProfile(cred.user);

  if (!profile) {
    await signOut(auth);
    throw new Error(
      "Akun Anda belum terdaftar sebagai user aplikasi. Hubungi Admin agar ditambahkan di menu Manajemen User."
    );
  }
  if (profile.aktif === false) {
    await signOut(auth);
    throw new Error("Akun Anda dinonaktifkan. Hubungi Admin.");
  }

  currentUser = profile;
  return profile;
}

/** Keluar dari sesi. */
export async function logout() {
  try {
    await signOut(auth);
  } finally {
    currentUser = null;
  }
}

/**
 * Pasang pemantau status login.
 * @param {(user: object|null) => void} onUser  dipanggil saat sesi berubah
 *        (user = profil lengkap, null = belum login)
 */
export function watchAuth(onUser) {
  if (!IS_CONFIG_READY) {
    onUser(null);
    return () => {};
  }
  return onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      currentUser = null;
      onUser(null);
      return;
    }
    const profile = await fetchUserProfile(fbUser);
    if (!profile || profile.aktif === false) {
      await signOut(auth);
      currentUser = null;
      onUser(null);
      return;
    }
    currentUser = profile;
    onUser(profile);
  });
}

/** Pesan galat login untuk ditampilkan di form. */
export function loginErrorText(err) {
  return esc(friendlyError(err));
}

export { toast };
