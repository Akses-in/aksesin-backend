import { createClient } from '@supabase/supabase-js';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  CardDomainError,
  type CardApplicationStore,
  createCardApplicationSchema,
  createInMemoryCardStore,
  createPrismaCardStore,
  statusTransitionSchema,
  updateCardApplicationSchema,
} from '../services/card-application.js';

const devFallbackStore = createInMemoryCardStore();

function createResilientCardStore(): CardApplicationStore {
  const primary = createPrismaCardStore();
  if (env.NODE_ENV === 'production') return primary;

  function wrap<Args extends unknown[], Ret>(
    fn: (...args: Args) => Promise<Ret>,
    fallbackFn: (...args: Args) => Promise<Ret>,
  ): (...args: Args) => Promise<Ret> {
    return async (...args: Args): Promise<Ret> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof CardDomainError) throw err;
        console.warn('Primary card store failed in dev; falling back for this request:', err instanceof Error ? err.message : 'UnknownError');
        return fallbackFn(...args);
      }
    };
  }

  return {
    listByUser: wrap(primary.listByUser.bind(primary), devFallbackStore.listByUser.bind(devFallbackStore)),
    getById: wrap(primary.getById.bind(primary), devFallbackStore.getById.bind(devFallbackStore)),
    getDocument: wrap(primary.getDocument.bind(primary), devFallbackStore.getDocument.bind(devFallbackStore)),
    create: wrap(primary.create.bind(primary), devFallbackStore.create.bind(devFallbackStore)),
    update: wrap(primary.update.bind(primary), devFallbackStore.update.bind(devFallbackStore)),
    cancel: wrap(primary.cancel.bind(primary), devFallbackStore.cancel.bind(devFallbackStore)),
    transitionStatus: wrap(
      primary.transitionStatus.bind(primary),
      devFallbackStore.transitionStatus.bind(devFallbackStore),
    ),
    listNotifications: wrap(
      primary.listNotifications.bind(primary),
      devFallbackStore.listNotifications.bind(devFallbackStore),
    ),
    markNotificationRead: wrap(
      primary.markNotificationRead.bind(primary),
      devFallbackStore.markNotificationRead.bind(devFallbackStore),
    ),
    markAllNotificationsRead: wrap(
      primary.markAllNotificationsRead.bind(primary),
      devFallbackStore.markAllNotificationsRead.bind(devFallbackStore),
    ),
    renew: wrap(primary.renew.bind(primary), devFallbackStore.renew.bind(devFallbackStore)),
    listForAdmin: wrap(primary.listForAdmin.bind(primary), devFallbackStore.listForAdmin.bind(devFallbackStore)),
    getDocumentForAdmin: wrap(
      primary.getDocumentForAdmin.bind(primary),
      devFallbackStore.getDocumentForAdmin.bind(devFallbackStore),
    ),
    findByQrToken: wrap(primary.findByQrToken.bind(primary), devFallbackStore.findByQrToken.bind(devFallbackStore)),
  };
}

export function getSharedCardStore(): CardApplicationStore {
  if (!env.DATABASE_URL) {
    if (env.NODE_ENV !== 'production') return devFallbackStore;
    throw new CardDomainError(503, 'DATABASE_UNAVAILABLE', 'Database pengajuan belum tersedia.');
  }
  return createResilientCardStore();
}

export interface AuthenticatedActor {
  id: string;
  role: 'user' | 'admin';
  name?: string;
}

export type AuthResolver = (req: Request) => Promise<AuthenticatedActor | null>;

const uuidParam = z.strictObject({
  id: z.uuid({ message: 'ID tidak valid.' }),
});

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
  const name = typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()
    ? user.user_metadata.full_name.trim()
    : (user.email ?? '');
  return {
    id: user.id,
    role: isAdmin ? 'admin' : 'user',
    name,
  };
}

function sendDomainError(res: Response, error: unknown): boolean {
  if (error instanceof CardDomainError) {
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

export function createCardApplicationsRouter(options?: {
  store?: CardApplicationStore;
  authResolver?: AuthResolver;
}): Router {
  const router = Router();
  const getStore = (): CardApplicationStore => {
    if (options?.store) return options.store;
    return getSharedCardStore();
  };
  const resolveAuth: AuthResolver = options?.authResolver ?? defaultSupabaseAuthResolver;

  // Three 5 MiB files expand to slightly over 20 MiB in base64.
  router.use(express.json({ limit: '21mb' }));

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

  // GET /api/card-applications — List current user's card applications
  router.get('/card-applications', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const items = await getStore().listByUser(actor.id);
      res.json({ data: items });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/card-applications — Submit a new Digital Accessibility Card application
  router.post('/card-applications', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const input = createCardApplicationSchema.parse(req.body);
      const result = await getStore().create(actor.id, input);
      res.status(201).json({ data: result.application, notification: result.notification });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/card-applications/:id — Get detail of a specific application (owner only)
  router.get('/card-applications/:id', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id } = uuidParam.parse(req.params);
      const application = await getStore().getById(id);
      if (!application) {
        res.status(404).json({
          error: { code: 'APPLICATION_NOT_FOUND', message: 'Data pengajuan kartu tidak ditemukan.' },
        });
        return;
      }

      if (application.userId !== actor.id && actor.role !== 'admin') {
        res.status(403).json({
          error: { code: 'FORBIDDEN_ACCESS', message: 'Anda tidak memiliki akses ke data pengajuan ini.' },
        });
        return;
      }

      res.json({ data: application });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  router.get('/card-applications/:id/documents/:documentId', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id, documentId } = uuidParam.extend({ documentId: z.uuid() }).parse(req.params);
      const document = await getStore().getDocument(actor.id, id, documentId);
      if (!document) {
        throw new CardDomainError(404, 'DOCUMENT_NOT_FOUND', 'Dokumen tidak tersedia.');
      }

      res.set({
        'Content-Type': document.mimeType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      });
      res.send(Buffer.from(document.content));
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // PATCH /api/card-applications/:id — Update application data / re-upload supporting document before verification finishes
  router.patch('/card-applications/:id', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id } = uuidParam.parse(req.params);
      const input = updateCardApplicationSchema.parse(req.body);
      const result = await getStore().update(actor.id, id, input);
      res.json({ data: result.application, notification: result.notification ?? null });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/card-applications/:id/cancel — Cancel application & withdraw uploaded document
  router.post('/card-applications/:id/cancel', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id } = uuidParam.parse(req.params);
      const result = await getStore().cancel(actor.id, id);
      res.json({ data: result.application, notification: result.notification });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/card-applications/:id/status — Reviewer/Admin status transition trigger (PBI-18)
  router.post('/card-applications/:id/status', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      if (actor.role !== 'admin') {
        res.status(403).json({
          error: {
            code: 'FORBIDDEN_ROLE',
            message: 'Hanya peninjau atau admin yang dapat mengubah status verifikasi kartu.',
          },
        });
        return;
      }

      const { id } = uuidParam.parse(req.params);
      const input = statusTransitionSchema.parse(req.body);
      const result = await getStore().transitionStatus(
        { id: actor.id, role: actor.role, name: actor.name?.trim() || 'Admin AksesIn' },
        id,
        input,
      );
      res.json({
        data: result.application,
        notification: result.notification,
        idempotent: result.idempotent,
      });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // GET /api/notifications — List current user's status notifications (PBI-18)
  router.get('/notifications', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const notifications = await getStore().listNotifications(actor.id);
      const unreadCount = notifications.filter((n) => !n.isRead).length;
      res.json({
        data: {
          items: notifications,
          unreadCount,
        },
      });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // PATCH /api/notifications/:id/read — Mark a specific notification as read (owner only)
  router.patch('/notifications/:id/read', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const { id } = uuidParam.parse(req.params);
      const notification = await getStore().markNotificationRead(actor.id, id);
      res.json({ data: notification });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  // POST /api/notifications/read-all — Mark all current user's notifications as read
  router.post('/notifications/read-all', async (req, res, next) => {
    try {
      const actor = await requireAuth(req, res);
      if (!actor) return;

      const updatedCount = await getStore().markAllNotificationsRead(actor.id);
      res.json({ data: { updatedCount } });
    } catch (error) {
      if (!sendDomainError(res, error)) next(error);
    }
  });

  return router;
}

export const cardApplicationsRouter = createCardApplicationsRouter();

