# Akses.in Backend

Express 5 + TypeScript (ESM), Prisma 7, PostgreSQL Supabase, dan Zod 4.
Versi dependency dipatok di `package.json` dan `package-lock.json`.

## Menjalankan

Gunakan Node.js 22.12+ (proyek ini diuji dengan Node.js 22.17.0).

```sh
npm ci
cp .env.example .env
npm run db:generate
npm run dev
```

Lewati `cp` jika `.env` sudah ada. Default server: `http://127.0.0.1:3000`.
`npm run dev` otomatis memuat ulang saat file TypeScript berubah.
Server dapat berjalan tanpa database dalam mode development; production mewajibkan `DATABASE_URL`.
Untuk deployment/container, sesuaikan `HOST=0.0.0.0` dan `CORS_ORIGINS` dengan alamat frontend.

## Menghubungkan Supabase

1. Buka proyek Supabase → **Connect** → **Session pooler**, port **5432**.
2. Salin URI ke `DATABASE_URL` di `.env` dan isi password database. URL-encode karakter khusus dalam password.
3. Isi `DIRECT_URL` untuk Prisma CLI dengan URI Session pooler yang sama atau Direct connection jika jaringan mendukung IPv6.
4. Gunakan SSL dengan verifikasi sertifikat, misalnya `sslmode=verify-full`. Jangan menonaktifkan verifikasi TLS.
5. Restart server setelah mengganti `.env`, lalu jalankan:

```sh
npm run db:check
```

Perintah tersebut menjalankan `SELECT 1` melalui Prisma. `GET /health/db` juga menguji koneksi sebenarnya dan mengembalikan HTTP 503 jika database belum tersedia.
Connection string dan password hanya disimpan di `.env` yang diabaikan Git.
Integrasi database memakai Prisma + driver PostgreSQL sehingga Supabase API key dan SDK tidak diperlukan.

Schema awal sengaja belum memiliki model: tambahkan model sesuai kebutuhan aplikasi ke `prisma/schema.prisma`.
Untuk database Supabase yang sudah memiliki tabel, gunakan `npm run db:pull` lalu review hasil introspeksinya sebelum membuat migrasi.
Jangan reset database berisi data ketika Prisma meminta reset.

Untuk perubahan schema baru:

```sh
npm run db:migrate -- --name nama_perubahan --create-only
# Review SQL migrasi sebelum menerapkannya.
npm run db:migrate
npm run db:generate
```

Prisma Migrate development memerlukan shadow database. Jika role Supabase tidak memiliki izin membuat database,
siapkan database development/shadow terpisah dan konfigurasi `datasource.shadowDatabaseUrl` di `prisma.config.ts`.
Gunakan `npm run db:deploy` untuk menerapkan migrasi yang sudah direview pada deployment.

Untuk tabel baru di schema `public` Supabase, tambahkan `ALTER TABLE public."NamaTabel" ENABLE ROW LEVEL SECURITY;`
ke SQL migrasi sebelum diterapkan. Tambahkan policy hanya sesuai akses yang dibutuhkan.
Koneksi Prisma memakai role database dan tidak otomatis mewakili pengguna Supabase Auth;
endpoint data berikutnya tetap perlu autentikasi dan otorisasi.

## OTP WhatsApp lewat Fonnte

Express mengirim kode langsung melalui Fonnte. OTP berlaku lima menit dan hanya bisa dipakai sekali. Backend menyimpan hash kode serta membatasi pengiriman ulang dan percobaan verifikasi.

1. Hubungkan perangkat WhatsApp di Fonnte, lalu simpan tokennya sebagai `FONNTE_TOKEN` di `aksesin-backend/.env`.
2. Isi `SUPABASE_URL` dan `SUPABASE_PUBLISHABLE_KEY` dengan nilai proyek yang sama dengan frontend. Di **Supabase → Project Settings → API Keys**, buat secret key untuk backend dan simpan sebagai `SUPABASE_SECRET_KEY`. Express memakai key ini untuk membuat akun setelah OTP benar.
3. Terapkan migrasi `direct_whatsapp_otp`, `account_whatsapp_change`, dan `whatsapp_login_otp` sesuai urutannya, lalu jalankan ulang backend dengan `npm run dev`.

Pengguna masuk dengan nomor WhatsApp terverifikasi dan OTP. Setelah kode benar, backend memakai identitas email akun di Supabase untuk membuat sesi tanpa mengirim email. Akun WhatsApp memakai identitas email internal yang dibuat saat pendaftaran. Pengiriman langsung ini tidak membutuhkan Twilio, Phone provider, atau Send SMS Hook.

## Impor tempat dari OpenStreetMap

Admin menjalankan impor data tempat DKI Jakarta dari Overpass API. Backend menyimpan hasilnya ke tabel `places`,
lalu peta dan halaman admin membaca dari database, bukan langsung dari Overpass.

1. Terapkan migration `20261113100000_osm_place_import` lalu `20261113100100_admin_notifications`.
2. Opsional: atur `OVERPASS_URLS` (daftar HTTPS dipisah koma, dicoba berurutan). Default memakai
   `overpass-api.de` lalu `overpass.kumi.systems`.

- Impor berjalan di latar belakang dengan status `queued -> running -> succeeded | failed`. Hanya satu job boleh aktif.
- Impor ulang memperbarui tempat berdasarkan `(osm_type, osm_id)` dan hanya menghitung "diperbarui" bila isinya berubah.
- Data `manual` dan tempat yang sudah diedit admin tidak ditimpa impor. Tempat OSM yang dihapus admin dicatat di
  `place_import_exclusions` supaya tidak masuk lagi.
- Bila semua endpoint Overpass gagal, job ditandai `failed` dan tabel `places` tidak berubah. Seluruh penyimpanan
  satu impor berjalan dalam satu transaksi.
- Saat server start, job yang tertinggal berstatus `queued`/`running` ditandai gagal.
- Setiap job yang selesai membuat satu notifikasi admin.

Semua endpoint di bawah memerlukan `Authorization: Bearer <token>` akun dengan `app_metadata.role = "admin"`.
Tanpa token: 401 `UNAUTHORIZED`. Bukan admin: 403 `FORBIDDEN`.

| Method | Path | Kegunaan |
| --- | --- | --- |
| POST | `/api/admin/osm-imports` | Mulai impor (202), 409 bila masih ada job aktif |
| GET | `/api/admin/osm-imports?page=&pageSize=` | Riwayat impor, terbaru dulu |
| GET | `/api/admin/osm-imports/:id` | Detail job untuk polling status |
| GET | `/api/admin/places?q=&status=&source=&page=&pageSize=` | Daftar tempat dan atribut aksesibilitas (`pageSize` maks. 100) |
| GET | `/api/admin/places/duplicates` | Kandidat duplikat: nama sama dan jarak < 50 m |
| PATCH | `/api/admin/places/:id` | Ubah nama, kategori, alamat, koordinat, status, atau atribut aksesibilitas |
| DELETE | `/api/admin/places/:id` | Hapus tempat. Body opsional `{ "reason": "duplicate" \| "invalid" }` |
| GET | `/api/admin/notifications?unread=true` | Notifikasi hasil impor |
| PATCH | `/api/admin/notifications/:id/read` | Tandai notifikasi sudah dibaca |

Menghapus tempat ikut menghapus lokasi tersimpan dan kontribusi pengguna untuk tempat itu (`ON DELETE CASCADE`).
Respons DELETE menyertakan `savedByCount` dan `contributionCount`.
Data tempat © kontributor OpenStreetMap, lisensi [ODbL](https://www.openstreetmap.org/copyright).

## Endpoint awal

| Method | Path | Kegunaan |
| --- | --- | --- |
| GET | `/` | Identitas API |
| GET | `/health` | Status proses server |
| GET | `/health/db` | Koneksi database melalui Prisma |
| POST | `/api/echo` | Contoh validasi body dengan Zod |

```sh
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/api/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"Halo Akses.in"}'
```

Body echo hanya menerima `message`, string 1–500 karakter setelah trim.
Error validasi mengembalikan HTTP 400 dengan `{ "error": { "code", "message", "details" } }`.
Body JSON dibatasi 100 KB. Header keamanan memakai Helmet, origin frontend diatur lewat `CORS_ORIGINS`.

## Perintah

```sh
npm run typecheck
npm test
npm run db:validate
npm run build
npm start
npm run db:studio
```

`npm run build` membuat Prisma Client dan mengompilasi server ke `dist/`.
Client hasil generate dan output build diabaikan Git.

## Struktur

```text
prisma/schema.prisma       Schema database
prisma.config.ts           Konfigurasi Prisma CLI
src/app.ts                 Express dan middleware
src/server.ts              HTTP server dan graceful shutdown
src/config/env.ts          Validasi environment dengan Zod
src/lib/prisma.ts          Prisma Client dan connection pool
src/routes/index.ts        Endpoint awal
src/middleware/            Error handler
scripts/check-db.ts        Uji koneksi Supabase
tests/app.test.ts          Pengujian HTTP dan validasi
```

Referensi: [Express](https://expressjs.com/en/starter/installing/),
[Prisma 7](https://www.prisma.io/docs/orm/v7),
[Supabase + Prisma](https://supabase.com/docs/guides/database/prisma).
