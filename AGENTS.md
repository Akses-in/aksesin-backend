# Aksesin Backend

Panduan ini berlaku untuk repositori backend Express. Standar desain, komponen UI, dan aturan Next.js ada di `AGENTS.md` pada repositori frontend.

## Mulai dari implementasi yang ada

- Baca route, skema, dan pemanggil yang terdampak sebelum mengubah kode. Pertahankan kontrak API yang sudah dipakai dan cocokkan perubahan lintas repositori dengan frontend.
- Pakai TypeScript ESM dan pertahankan ekstensi `.js` pada import relatif. Pilih perubahan terkecil yang menyelesaikan kebutuhan. Tambahkan dependency atau abstraksi hanya jika diperlukan.
- Gunakan komentar untuk menjelaskan batas keamanan, efek samping, atau alasan teknis yang sulit terlihat dari kode. Hindari komentar yang mengulang isi baris.

## Struktur dan kontrak

| Kebutuhan | Gunakan |
| --- | --- |
| Entry point dan server | `src/app.ts` dan `src/server.ts` |
| Route API | `src/routes/index.ts` sebagai tempat memasang router. Letakkan route per fitur di `src/routes/` |
| Registrasi, login, dan perubahan nomor | `src/routes/whatsapp.ts` |
| Validasi input dan error | Zod pada batas request dan `src/middleware/error-handler.ts` |
| Konfigurasi environment | `src/config/env.ts` dan placeholder pada `.env.example` |
| Koneksi database | `getPrisma()` dari `src/lib/prisma.ts` |
| Skema fitur Supabase dan kebijakan akses | SQL berversi di `supabase/migrations/` |
| Tes HTTP | `tests/` dengan Supertest dan Node test runner |

- Validasi input sebelum melakukan kueri atau memanggil provider. Pakai kueri berparameter, kode HTTP sesuai kontrak, serta pesan error yang aman dan singkat.
- Pakai migrasi baru untuk mengubah tabel yang sudah dikelola di `supabase/migrations/`. Pertahankan data lama. Jalankan perubahan skema di lingkungan uji sebelum menerapkan ke proyek bersama. Pertahankan verifikasi TLS untuk koneksi Supabase.
- Batasi tabel privat dan gunakan RLS berbasis pemilik untuk data akun yang diakses dari Supabase. Koneksi Prisma dengan kredensial database memerlukan pemeriksaan otorisasi di kode. Verifikasi sesi dan ambil identitas pengguna dari token yang sudah diverifikasi sebelum mengubah akun.

## Aturan autentikasi dan OTP

- Express mengirim WhatsApp lewat Fonnte. Supabase Auth menyimpan akun, password, dan sesi. Pertahankan alur login WhatsApp + password serta email + password untuk akun lama.
- Simpan hash OTP di skema privat. Pertahankan masa berlaku, batas kirim dan percobaan, serta konsumsi sekali pakai. Gunakan transaksi untuk menjaga konsistensi saat request bersamaan.
- Pisahkan challenge registrasi dari challenge ganti nomor. Ikat perubahan nomor ke akun yang sedang masuk dan nomor baru yang diminta. Perbarui akun hanya setelah OTP untuk nomor baru benar.
- Simpan `FONNTE_TOKEN`, `SUPABASE_SECRET_KEY`, dan `DATABASE_URL` di environment backend. Jauhkan OTP, password, kredensial, dan respons internal provider dari log, respons browser, serta Git.

## Cek sebelum menyerahkan perubahan

- Gunakan Node.js 22.12 atau lebih baru. Jalankan `npm run typecheck`, `npm test`, dan `npm run build`.
- Jika mengubah akses database, jalankan `npm run db:check` dengan environment uji yang tepat. Jika mengubah OTP, uji kode salah, kedaluwarsa, kirim ulang, penggunaan ulang, dan akses dari akun lain dengan provider tiruan.
