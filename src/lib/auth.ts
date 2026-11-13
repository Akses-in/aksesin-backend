import { createClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { env } from '../config/env.js';

export interface AuthenticatedActor {
  id: string;
  role: 'user' | 'admin';
}

export type AuthResolver = (req: Request) => Promise<AuthenticatedActor | null>;

// Identitas diambil dari token yang diverifikasi Supabase, bukan dari input klien.
// Role admin hanya dibaca dari app_metadata yang tidak bisa diubah pengguna.
export async function supabaseAuthResolver(req: Request): Promise<AuthenticatedActor | null> {
  const accessToken = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!accessToken) return null;

  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return null;
  }

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    },
  });

  const { data: { user }, error } = await client.auth.getUser(accessToken);
  if (error || (!user?.email_confirmed_at && !user?.phone_confirmed_at)) {
    return null;
  }

  return {
    id: user.id,
    role: user.app_metadata?.role === 'admin' ? 'admin' : 'user',
  };
}
