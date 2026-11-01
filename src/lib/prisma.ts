import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL has not been configured');
  }

  client ??= new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 5000,
    }),
  });

  return client;
}

export async function disconnectDatabase(): Promise<void> {
  await client?.$disconnect();
}
