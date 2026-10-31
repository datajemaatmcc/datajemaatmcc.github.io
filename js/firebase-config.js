/* =========================================================
   firebase-config.js — konfigurasi & inisialisasi Firebase
   Ganti SEMUA nilai placeholder di bawah dengan kredensial
   milikmu dari Firebase Console:
     Project settings → General → Your apps → SDK setup and configuration
   Jangan pernah menaruh kunci rahasia lain di sini.
   ========================================================= */

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

/* --- Kredensial web app dari Firebase Console (dipakai untuk identifikasi
       proyek; keamanan sesungguhnya tetap di Firestore Security Rules) --- */
export const firebaseConfig = {
  apiKey: "AIzaSyB60ltRqvrxJrQ8YrLH6_q_yNY_8QOdcDc",
  authDomain: "datajemaat.firebaseapp.com",
  projectId: "datajemaat",
  storageBucket: "datajemaat.firebasestorage.app",
  messagingSenderId: "435656571993",
  appId: "1:435656571993:web:8c4d099143a5c449ae4548",
  measurementId: "G-P6ZT9BQ59T",
};
/* -------------------------------------------------------------------- */

/** True bila konfigurasi sudah diganti dari placeholder. */
export const IS_CONFIG_READY =
  typeof firebaseConfig.apiKey === "string" &&
  !firebaseConfig.apiKey.startsWith("ISI_");

/** Instance aplikasi Firebase (hanya dibuat bila config valid). */
export let app = null;
/** Layanan autentikasi email/password. */
export let auth = null;
/** Database Firestore. */
export let db = null;

if (IS_CONFIG_READY) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}
