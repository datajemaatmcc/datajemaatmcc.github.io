/* =========================================================
   api/sheets.js — Proxy absensi → Google Sheets (Vercel Function)

   Kenapa perlu: situs statis (GitHub Pages) tidak boleh menyimpan
   kunci service account. Berkas kunci hanya hidup di environment
   variable Vercel, dan peramban cukup memanggil endpoint ini.

   Environment variable (Vercel → Settings → Environment Variables):
     SA_KEY_JSON  seluruh isi berkas kunci .json service account
     SHEET_ID     ID spreadsheet tujuan absensi

   Body (POST JSON): { sheet, header, rows }
   Respons: { ok: true, updated } | { error: "pesan" }

   Nol dependensi: memakai fetch + webcrypto bawaan Node 18+.
   Ditulis dalam CommonJS agar jalan apa adanya di Vercel.
   ========================================================= */

const { webcrypto: crypto } = require("node:crypto");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const b64url = (data) => Buffer.from(data).toString("base64url");

function pemKeBuffer(pem) {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

/** Tukar JWT RS256 (ditandatangani kunci privat SA) → token akses Google. */
async function ambilToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  )}`;
  const kunci = await crypto.subtle.importKey(
    "pkcs8",
    pemKeBuffer(sa.private_key),
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
  return json.access_token;
}

/** Panggil Sheets API v4; lempar Error berisi pesan Google. */
async function panggil(token, path, init = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    let pesan = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      pesan = (parsed.error && parsed.error.message) || pesan;
    } catch {
      /* biarkan pesan HTTP */
    }
    throw new Error(pesan);
  }
  return text ? JSON.parse(text) : {};
}

function kirim(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  // CORS: izinkan asal pemanggil (situs GitHub Pages & localhost).
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return kirim(res, 405, { error: "Method not allowed." });
  }

  try {
    const { sheet, header, rows } = req.body || {};
    if (!sheet || !Array.isArray(rows) || !rows.length) {
      return kirim(res, 400, { error: "Payload tidak lengkap (sheet/header/rows)." });
    }
    const raw = process.env.SA_KEY_JSON;
    const spreadsheetId = process.env.SHEET_ID;
    if (!raw) {
      return kirim(res, 500, { error: "SA_KEY_JSON belum diatur di environment Vercel." });
    }
    if (!spreadsheetId) {
      return kirim(res, 500, { error: "SHEET_ID belum diatur di environment Vercel." });
    }

    const sa = JSON.parse(raw);
    const token = await ambilToken(sa);

    // 1. Pastikan tab bulan ada (buat + tulis judul bila belum).
    const meta = await panggil(
      token,
      `spreadsheets/${spreadsheetId}?fields=sheets.properties(title)`
    );
    const ada = (meta.sheets || []).some((s) => s.properties.title === sheet);
    if (!ada) {
      await panggil(token, `spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheet } } }] }),
      });
      if (Array.isArray(header) && header.length) {
        await panggil(
          token,
          `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheet}'!A1`)}?valueInputOption=RAW`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ values: [header] }),
          }
        );
      }
    }

    // 2. Append baris absensi.
    const out = await panggil(
      token,
      `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
        `'${sheet}'!A1`
      )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: rows }),
      }
    );

    return kirim(res, 200, { ok: true, updated: out.updates || null });
  } catch (err) {
    console.error("[sheets-proxy]", err);
    return kirim(res, 500, { error: err.message || "Proxy gagal memproses permintaan." });
  }
}

module.exports = handler;
