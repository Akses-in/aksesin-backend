import { env } from '../src/config/env.js';
import { disconnectDatabase, getPrisma } from '../src/lib/prisma.js';

if (!env.DATABASE_URL) {
  console.error('Isi DATABASE_URL di .env dengan connection string Supabase terlebih dahulu.');
  process.exitCode = 1;
} else {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    console.log('Supabase PostgreSQL connected: SELECT 1 succeeded.');
  } catch {
    console.error('Koneksi database gagal. Periksa URL, password, SSL, dan akses jaringan.');
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}
