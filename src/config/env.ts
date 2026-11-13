import 'dotenv/config';
import { z } from 'zod';

const databaseUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'postgres:' || protocol === 'postgresql:';
}, 'Must be a PostgreSQL connection URL');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url())),
  DATABASE_URL: databaseUrl.optional(),
  DIRECT_URL: databaseUrl.optional(),
  FONNTE_TOKEN: z.string().trim().min(1).optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().startsWith('sb_publishable_').optional(),
  SUPABASE_SECRET_KEY: z.string().startsWith('sb_secret_').optional(),
  OVERPASS_URLS: z.string()
    .default('https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter')
    .transform((value) => value.split(',').map((url) => url.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https$/ })).min(1).max(5)),
}).refine((value) => value.NODE_ENV !== 'production' || Boolean(value.DATABASE_URL), {
  path: ['DATABASE_URL'],
  message: 'DATABASE_URL is required in production',
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:', result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  })));
  throw new Error('Invalid environment configuration. Check your .env file.');
}

export const env = result.data;
