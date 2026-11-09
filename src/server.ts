import { app } from './app.js';
import { env } from './config/env.js';
import { disconnectDatabase } from './lib/prisma.js';
import { ensureCardTablesExist } from './services/card-application.js';

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`API listening on http://${env.HOST}:${env.PORT}`);
  if (!env.DATABASE_URL) {
    console.log('Supabase belum dikonfigurasi. Isi DATABASE_URL di .env untuk mengaktifkan database.');
  } else {
    void ensureCardTablesExist().catch((err) => {
      console.error('Gagal menginisialisasi skema kartu aksesibilitas:', err instanceof Error ? err.message : err);
    });
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`Server failed to start: ${error.code ?? 'UNKNOWN_ERROR'}`);
  process.exitCode = 1;
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();

  server.close(() => {
    void disconnectDatabase().then(() => {
      clearTimeout(timeout);
      process.exit(0);
    }).catch(() => {
      console.error('Database shutdown failed');
      process.exit(1);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
