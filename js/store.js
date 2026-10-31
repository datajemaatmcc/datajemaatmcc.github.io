/* =========================================================
   store.js — helper Firestore bersama semua modul
   - catatAudit()        : tulis jejak aksi ke `audit_log`
   - hitungRingkasanJemaat() : dokumen ringkasan jemaat (pake agregat
                           murah, TIDAK membaca ribuan dokumen)
   - ubahRingkasanKeuangan() : update kumulatif kas saat transaksi
                           ditambah/ubah/hapus (delta, hemat kuota)
   - hitungUlangKeuangan()   : perhitungan ulang penuh (darurat)
   - unduhCSV()          : ekspor tabel ke file CSV
   ========================================================= */

import { db } from "./firebase-config.js";
import { currentUser } from "./auth.js";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  getCountFromServer,
  serverTimestamp,
} from "firebase/firestore";
import { ageFrom } from "./utils.js";

/* ---------------- Audit trail ---------------- */

/** Cetak aksi pengguna ke `audit_log`. Gagal menulis tidak boleh merusak alur utama. */
export async function catatAudit(aksi, koleksi, docId, detail) {
  try {
    await addDoc(collection(db, "audit_log"), {
      userId: (currentUser && currentUser.uid) || "-",
      userName: (currentUser && (currentUser.nama || currentUser.email)) || "-",
      aksi: String(aksi || "-"),
      koleksi: String(koleksi || "-"),
      docId: String(docId || "-"),
      detail: String(detail || ""),
      waktu: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Audit log gagal ditulis:", err);
  }
}

/* ---------------- Pengaturan ---------------- */

/** Baca dokumen pengaturan/{nama}; null bila belum pernah diisi. */
export async function ambilPengaturan(nama) {
  const snap = await getDoc(doc(db, "pengaturan", nama));
  return snap.exists() ? snap.data() : null;
}

/* ---------------- Kategori umur ---------------- */

export const UMUR_KATEGORI = ["Anak", "Remaja", "Pemuda", "Dewasa", "Lansia"];
export const BATAS_UMUR_DEFAULT = { anak: 12, remaja: 18, pemuda: 30, lansia: 60 };

/**
 * Kelompokkan umur → Anak / Remaja / Pemuda / Dewasa / Lansia
 * sesuai batas di pengaturan/profil (batasUmur).
 */
export function kategoriUmurDari(tanggalLahir, batas) {
  const umur = ageFrom(tanggalLahir);
  if (umur === null) return "";
  const b = { ...BATAS_UMUR_DEFAULT, ...(batas || {}) };
  if (umur <= Number(b.anak)) return "Anak";
  if (umur <= Number(b.remaja)) return "Remaja";
  if (umur <= Number(b.pemuda)) return "Pemuda";
  if (umur < Number(b.lansia)) return "Dewasa";
  return "Lansia";
}

/* ---------------- Ringkasan jemaat ---------------- */

/**
 * Hitung ulang `ringkasan/jemaat` memakai agregat Firestore
 * (getCountFromServer ≈ 1 read per query, bukan per dokumen).
 */
export async function hitungRingkasanJemaat() {
  const kol = collection(db, "jemaat");
  const hitung = (q) => getCountFromServer(q).then((s) => s.data().count);

  const [total, aktif, laki, perempuan, kategori] = await Promise.all([
    hitung(kol),
    hitung(query(kol, where("status", "==", "Aktif"))),
    hitung(query(kol, where("jenisKelamin", "==", "L"))),
    hitung(query(kol, where("jenisKelamin", "==", "P"))),
    ambilPengaturan("kategori"),
  ]);

  const wilayahList = ((kategori && kategori.wilayah) || []).slice();
  const perWilayah = {};
  await Promise.all(
    wilayahList.map(async (w) => {
      perWilayah[w] = await hitung(query(kol, where("wilayah", "==", w)));
    })
  );

  const perUmur = {};
  await Promise.all(
    UMUR_KATEGORI.map(async (k) => {
      perUmur[k] = await hitung(query(kol, where("kategoriUmur", "==", k)));
    })
  );

  // Jumlah ultah per bulan (query jangkauan string "MM-DD")
  const tahun = new Date().getFullYear();
  const perBulanUlangTahun = [];
  for (let m = 0; m < 12; m++) {
    const mm = String(m + 1).padStart(2, "0");
    const hari = new Date(tahun, m + 1, 0).getDate();
    perBulanUlangTahun[m] = await hitung(
      query(
        kol,
        where("ultahMD", ">=", `${mm}-01`),
        where("ultahMD", "<=", `${mm}-${String(hari).padStart(2, "0")}`)
      )
    );
  }

  const data = {
    total,
    aktif,
    pasif: Math.max(total - aktif, 0),
    laki,
    perempuan,
    perWilayah,
    perUmur,
    perBulanUlangTahun,
    terakhirUpdate: serverTimestamp(),
  };
  await setDoc(doc(db, "ringkasan", "jemaat"), data, { merge: true });
  return data;
}

/* ---------------- Ringkasan keuangan ---------------- */

const pad2 = (n) => String(n).padStart(2, "0");

/** Kunci bulan untuk perBulan: "2026-10" */
function kunciBulan(tanggal) {
  const d = tanggal instanceof Date ? tanggal : new Date(tanggal);
  if (isNaN(d.getTime())) return "lain";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Tambahkan delta ke satu dokumen ringkasan kas. */
async function terapkanDelta(ref, delta, bulan) {
  const snap = await getDoc(ref);
  const d = snap.exists() ? snap.data() : {};
  const perBulan = { ...(d.perBulan || {}) };
  const cur = perBulan[bulan] || { masuk: 0, keluar: 0 };
  perBulan[bulan] = {
    masuk: (Number(cur.masuk) || 0) + delta.masuk,
    keluar: (Number(cur.keluar) || 0) + delta.keluar,
  };
  const pemasukan = (Number(d.pemasukan) || 0) + delta.masuk;
  const pengeluaran = (Number(d.pengeluaran) || 0) + delta.keluar;
  await setDoc(
    ref,
    {
      pemasukan,
      pengeluaran,
      saldo: pemasukan - pengeluaran,
      perBulan,
      terakhirUpdate: serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Perbarui ringkasan kas akibat satu transaksi.
 * Nilai delta boleh negatif (saat mengubah/menghapus transaksi lama).
 *
 * @param {object} delta  { proyekId, tanggal: Date, masuk: number, keluar: number }
 */
export async function ubahRingkasanKeuangan(delta) {
  const bulan = kunciBulan(delta.tanggal);
  const jobs = [terapkanDelta(doc(db, "ringkasan", "kas_total"), delta, bulan)];
  if (delta.proyekId) {
    jobs.push(
      terapkanDelta(doc(db, "ringkasan", `kas_${delta.proyekId}`), delta, bulan)
    );
  }
  await Promise.all(jobs);
}

/**
 * Hitung ulang SELURUH ringkasan kas dari nol (perbaikan data
 * yang tidak seimbang). Membaca semua dokumen transaksi —
 * pakai seperlunya saja karena menghabiskan kuota baca.
 */
export async function hitungUlangKeuangan() {
  let snap;
  try {
    snap = await getDocs(collection(db, "transaksi"));
  } catch {
    snap = null;
  }
  const semua = snap ? snap.docs.map((d) => d.data() || {}) : [];

  const akum = () => ({ pemasukan: 0, pengeluaran: 0, perBulan: {} });
  const total = akum();
  const perProyek = {};

  const catat = (target, jenis, nominal, bulan) => {
    if (jenis === "masuk") target.pemasukan += nominal;
    else target.pengeluaran += nominal;
    const cur = target.perBulan[bulan] || { masuk: 0, keluar: 0 };
    if (jenis === "masuk") cur.masuk += nominal;
    else cur.keluar += nominal;
    target.perBulan[bulan] = cur;
  };

  semua.forEach((v) => {
    const nominal = Number(v.nominal) || 0;
    const bulan = kunciBulan(
      v.tanggal && typeof v.tanggal.toDate === "function" ? v.tanggal.toDate() : v.tanggal
    );
    catat(total, v.jenis, nominal, bulan);
    const pid = v.proyekId || "";
    if (!perProyek[pid]) perProyek[pid] = akum();
    catat(perProyek[pid], v.jenis, nominal, bulan);
  });

  const tulis = (ref, data) =>
    setDoc(
      ref,
      { ...data, saldo: data.pemasukan - data.pengeluaran, terakhirUpdate: serverTimestamp() },
      { merge: true }
    );

  await tulis(doc(db, "ringkasan", "kas_total"), total);
  for (const pid of Object.keys(perProyek)) {
    if (!pid) continue;
    await tulis(doc(db, "ringkasan", `kas_${pid}`), perProyek[pid]);
  }
  return { totalDiproses: semua.length, proyek: Object.keys(perProyek).filter(Boolean).length };
}

/* ---------------- CSV ---------------- */

/** Unduh array-of-arrays sebagai file CSV (BOM supaya Excel membaca UTF-8). */
export function unduhCSV(namaFile, baris) {
  const isi = baris
    .map((baris1) =>
      baris1
        .map((sel) => {
          const s = sel === null || sel === undefined ? "" : String(sel);
          return /["\n\r,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(";")
    )
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + isi], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = namaFile;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
