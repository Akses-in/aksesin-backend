import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { supabaseAuthResolver, type AuthenticatedActor, type AuthResolver } from '../lib/auth.js';
import { createOverpassFetcher, type OverpassFetcher } from '../services/overpass.js';
import {
  PlaceImportError,
  createPrismaPlaceImportStore,
  deletePlaceSchema,
  jobListQuerySchema,
  notificationQuerySchema,
  placeListQuerySchema,
  runOsmImport,
  toPlaceImportError,
  updatePlaceSchema,
  uuidParamSchema,
  type PlaceImportStore,
} from '../services/place-import.js';

export type ImportScheduler = (task: () => Promise<void>) => void;

const runInBackground: ImportScheduler = (task) => {
  setImmediate(() => {
    void task();
  });
};

// Form GET dari frontend mengirim string kosong untuk filter yang tidak dipilih.
function withoutEmptyValues(query: Request['query']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''));
}

export function createAdminPlacesRouter(options?: {
  store?: PlaceImportStore;
  authResolver?: AuthResolver;
  fetchOverpass?: OverpassFetcher;
  schedule?: ImportScheduler;
}): Router {
  const router = Router();
  const resolveAuth = options?.authResolver ?? supabaseAuthResolver;
  const fetchOverpass = options?.fetchOverpass ?? createOverpassFetcher();
  const schedule = options?.schedule ?? runInBackground;
  let defaultStore: PlaceImportStore | undefined;

  const getStore = (): PlaceImportStore => {
    if (options?.store) return options.store;
    if (!env.DATABASE_URL) {
      throw new PlaceImportError(503, 'DATABASE_UNAVAILABLE', 'Database tempat belum tersedia.');
    }
    defaultStore ??= createPrismaPlaceImportStore();
    return defaultStore;
  };

  router.use('/admin', express.json({ limit: '100kb' }));
  router.use('/admin', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function requireAdmin(req: Request, res: Response): Promise<AuthenticatedActor | null> {
    const actor = await resolveAuth(req);
    if (!actor) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Sesi tidak valid. Silakan masuk terlebih dahulu.' },
      });
      return null;
    }
    if (actor.role !== 'admin') {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Hanya admin yang dapat mengelola data tempat.' },
      });
      return null;
    }
    return actor;
  }

  function handleError(error: unknown, res: Response, next: NextFunction): void {
    const domainError = toPlaceImportError(error);
    if (!domainError) {
      next(error);
      return;
    }
    res.status(domainError.status).json({ error: { code: domainError.code, message: domainError.message } });
  }

  type Handler = (req: Request, res: Response, actor: AuthenticatedActor) => Promise<void>;
  const adminOnly = (handler: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await requireAdmin(req, res);
      if (actor) await handler(req, res, actor);
    } catch (error) {
      handleError(error, res, next);
    }
  };

  // POST /api/admin/osm-imports: buat job lalu proses di latar belakang
  router.post('/admin/osm-imports', adminOnly(async (_req, res, actor) => {
    const store = getStore();
    const job = await store.createJob(actor.id);
    schedule(() => runOsmImport(store, job.id, fetchOverpass));
    res.status(202).json({ data: job });
  }));

  // GET /api/admin/osm-imports: riwayat job terbaru dulu
  router.get('/admin/osm-imports', adminOnly(async (req, res) => {
    const { page, pageSize } = jobListQuerySchema.parse(withoutEmptyValues(req.query));
    res.json({ data: await getStore().listJobs(page, pageSize) });
  }));

  // GET /api/admin/osm-imports/:id: detail job untuk polling status
  router.get('/admin/osm-imports/:id', adminOnly(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const job = await getStore().getJob(id);
    if (!job) throw new PlaceImportError(404, 'IMPORT_NOT_FOUND', 'Job impor tidak ditemukan.');
    res.json({ data: job });
  }));

  // GET /api/admin/places: daftar tempat dan atribut aksesibilitas, dibaca dari database
  router.get('/admin/places', adminOnly(async (req, res) => {
    const query = placeListQuerySchema.parse(withoutEmptyValues(req.query));
    res.json({ data: await getStore().listPlaces(query) });
  }));

  // GET /api/admin/places/duplicates: nama sama setelah dinormalisasi dan berjarak < 50 m
  router.get('/admin/places/duplicates', adminOnly(async (_req, res) => {
    res.json({ data: { items: await getStore().findDuplicateCandidates(100) } });
  }));

  // PATCH /api/admin/places/:id: ubah data tempat. Hasil edit tidak ditimpa impor ulang.
  router.patch('/admin/places/:id', adminOnly(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const input = updatePlaceSchema.parse(req.body ?? {});
    const place = await getStore().updatePlace(id, input);
    if (!place) throw new PlaceImportError(404, 'PLACE_NOT_FOUND', 'Tempat tidak ditemukan.');
    res.json({ data: place });
  }));

  // DELETE /api/admin/places/:id: hapus tempat dan cegah tempat OSM masuk lagi
  router.delete('/admin/places/:id', adminOnly(async (req, res, actor) => {
    const { id } = uuidParamSchema.parse(req.params);
    const { reason } = deletePlaceSchema.parse(req.body ?? {});
    const result = await getStore().deletePlace(id, actor.id, reason ?? 'invalid');
    if (!result) throw new PlaceImportError(404, 'PLACE_NOT_FOUND', 'Tempat tidak ditemukan.');
    res.json({ data: result });
  }));

  // GET /api/admin/notifications?unread=true
  router.get('/admin/notifications', adminOnly(async (req, res) => {
    const { unread } = notificationQuerySchema.parse(withoutEmptyValues(req.query));
    res.json({ data: await getStore().listNotifications(unread === 'true') });
  }));

  // PATCH /api/admin/notifications/:id/read
  router.patch('/admin/notifications/:id/read', adminOnly(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const notification = await getStore().markNotificationRead(id);
    if (!notification) throw new PlaceImportError(404, 'NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
    res.json({ data: notification });
  }));

  return router;
}

export const adminPlacesRouter = createAdminPlacesRouter();
