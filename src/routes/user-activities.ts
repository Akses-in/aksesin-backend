import { createClient } from '@supabase/supabase-js';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  ActivityDomainError,
  activityQuerySchema,
  createCommentSchema,
  createContributionSchema,
  createPrismaActivityStore,
  type UserActivityStore,
} from '../services/user-activity.js';

export interface AuthenticatedActor {
  id: string;
  role: 'user' | 'admin';
}

export type AuthResolver = (req: Request) => Promise<AuthenticatedActor | null>;

async function defaultSupabaseAuthResolver(req: Request): Promise<AuthenticatedActor | null> {
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

  const isAdmin = user.app_metadata?.role === 'admin';
  return {
    id: user.id,
    role: isAdmin ? 'admin' : 'user',
  };
}

function sendDomainError(res: Response, error: unknown): boolean {
  if (error instanceof ActivityDomainError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return true;
  }
  return false;
}

export function createUserActivitiesRouter(options?: {
  store?: UserActivityStore;
  authResolver?: AuthResolver;
}): Router {
  const router = Router();
  const getStore = (): UserActivityStore => {
    if (options?.store) return options.store;
    if (!env.DATABASE_URL) {
      throw new ActivityDomainError(503, 'DATABASE_UNAVAILABLE', 'Database belum tersedia.');
    }
    return createPrismaActivityStore();
  };
  const resolveAuth: AuthResolver = options?.authResolver ?? defaultSupabaseAuthResolver;

  router.use(express.json());

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function requireAuth(req: Request, res: Response): Promise<AuthenticatedActor | null> {
    const actor = await resolveAuth(req);
    if (!actor) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Sesi tidak valid. Silakan masuk terlebih dahulu.',
        },
      });
      return null;
    }
    return actor;
  }

  // GET /api/me/activities — Riwayat aktivitas gabungan (komentar & kontribusi lokasi)
  router.get('/me/activities', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const query = activityQuerySchema.parse(req.query);
      const result = await getStore().listByUser(actor.id, query);
      res.json({ data: result });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/me/activities/summary — Ringkasan jumlah aktivitas
  router.get('/me/activities/summary', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const summary = await getStore().getSummary(actor.id);
      res.json({ data: summary });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/me/comments — Tambah komentar pada postingan komunitas (milik pengguna saat ini)
  router.post('/me/comments', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const input = createCommentSchema.parse(req.body);
      const comment = await getStore().createComment(actor.id, input);
      res.status(201).json({ data: comment });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/me/contributions — Tambah riwayat kontribusi review fasilitas lokasi
  router.post('/me/contributions', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const input = createContributionSchema.parse(req.body);
      const contribution = await getStore().createContribution(actor.id, input);
      res.status(201).json({ data: contribution });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/me/saved-places — Daftar tempat yang disimpan oleh pengguna
  router.get('/me/saved-places', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const items = await getStore().listSavedPlaces(actor.id);
      res.json({ data: items });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/me/saved-places — Simpan lokasi ke daftar pengguna
  router.post('/me/saved-places', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { placeId } = z.strictObject({ placeId: z.string().uuid() }).parse(req.body);
      const item = await getStore().addSavedPlace(actor.id, placeId);
      res.status(201).json({ data: item });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // DELETE /api/me/saved-places/:id — Hapus lokasi tersimpan pengguna
  router.delete('/me/saved-places/:id', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id } = z.strictObject({ id: z.string().uuid() }).parse(req.params);
      const removed = await getStore().removeSavedPlace(actor.id, id);
      if (!removed) {
        throw new ActivityDomainError(404, 'SAVED_PLACE_NOT_FOUND', 'Lokasi tersimpan tidak ditemukan.');
      }
      res.json({ data: { success: true } });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/me/profile-summary — Rangkuman statistik aktivitas & tempat tersimpan
  router.get('/me/profile-summary', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const summary = await getStore().getProfileSummary(actor.id);
      res.json({ data: summary });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/me/overview — Gabungan aktivitas & lokasi tersimpan dalam satu respon API
  router.get('/me/overview', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const [activitiesResult, savedPlaces, summary] = await Promise.all([
        getStore().listByUser(actor.id),
        getStore().listSavedPlaces(actor.id),
        getStore().getProfileSummary(actor.id),
      ]);

      res.json({
        data: {
          activities: activitiesResult.items,
          savedPlaces,
          summary,
        },
      });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  return router;
}

export const userActivitiesRouter = createUserActivitiesRouter();

