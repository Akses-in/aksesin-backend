import { env } from '../src/config/env.js';
import { disconnectDatabase, getPrisma } from '../src/lib/prisma.js';
import { ensureActivityTablesExist } from '../src/services/user-activity.js';

async function main() {
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is missing');
    process.exit(1);
  }
  try {
    console.log('Initializing activity tables in Supabase PostgreSQL...');
    await ensureActivityTablesExist();
    console.log('Tables initialized successfully!');
  } catch (err) {
    console.error('Failed to init tables:', err);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

void main();

