import { Router, type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  CardDomainError,
  QR_TOKEN_PATTERN,
  adminCardListQuerySchema,
  adminDecisionSchema,
  issuedCardState,
  renewCardSchema,
  revokeCardSchema,
  type CardApplicationStore,
  type PublicCardLookup,
  type ReviewActor,
} from '../services/card-application.js';
import {
  getSharedCardStore,
  type AuthResolver,
  type AuthenticatedActor,
} from './card-applications.js';

const uuidParam = z.strictObject({
  id: z.uuid({ message: 'ID pengajuan tidak valid.' }),
});

const documentParams = uuidParam.extend({
  documentId: z.uuid({ message: 'ID dokumen tidak valid.' }),
});

const qrTokenParam = z.strictObject({
  token: z.string().regex(QR_TOKEN_PATTERN, 'Token verifikasi kartu tidak valid.'),
});

function withoutEmptyValues(query: Request['query']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''));
}

function toActor(actor: AuthenticatedActor): ReviewActor {
  return {
    id: actor.id,
    role: actor.role,
    name: actor.name?.trim() || 'Admin AksesIn',
  };
}

function formatPublicVerification(lookup: PublicCardLookup) {
  const state = issuedCardState(lookup.status, lookup);
  const valid = lookup.status === 'verified' && state === 'active';
  const statusLabels: Record<typeof state, string> = {
    active: 'Aktif & Terverifikasi',
    expired: 'Kedaluwarsa',
    revoked: 'Dicabut',
  };
  return {
    valid,
    state,
    statusLabel: statusLabels[state],
    cardNumber: lookup.cardNumber,
    holderName: valid ? lookup.fullName : null,
    issuedAt: lookup.issuedAt,
    expiresAt: lookup.expiresAt,
    revokedAt: lookup.revokedAt,
  };
}

async function renderVerifyQrSvg(token: string, publicBaseUrl?: string): Promise<string> {
  const base = (publicBaseUrl ?? process.env.PUBLIC_APP_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const verifyUrl = `${base}/kartu/verifikasi/${token}`;
  return QRCode.toString(verifyUrl, {
    type: 'svg',
    margin: 1,
    width: 240,
    errorCorrectionLevel: 'M',
  });
}

export function createAdminCardApplicationsRouter(options?: {
  store?: CardApplicationStore;
  authResolver?: AuthResolver;
  publicBaseUrl?: string;
}): Router {
  const router = Router();
  const getStore = (): CardApplicationStore => options?.store ?? getSharedCardStore();
  let defaultAuthResolverPromise: Promise<AuthResolver> | null = null;

  async function resolveActor(req: Request): Promise<AuthenticatedActor | null> {
    if (options?.authResolver) return options.authResolver(req);
    defaultAuthResolverPromise ??= import('./card-applications.js').then(async () => {
      const { createClient } = await import('@supabase/supabase-js');
      const { env } = await import('../config/env.js');
      return async (request: Request): Promise<AuthenticatedActor | null> => {
        const accessToken = request.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
        if (!accessToken || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;
        const client = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
          },
        });
        const { data: { user }, error } = await client.auth.getUser(accessToken);
        if (error || (!user?.email_confirmed_at && !user?.phone_confirmed_at)) return null;
        const name = typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()
          ? user.user_metadata.full_name.trim()
          : (user.email ?? '');
        return {
          id: user.id,
          role: user.app_metadata?.role === 'admin' ? 'admin' : 'user',
          name,
        };
      };
    });
    const resolver = await defaultAuthResolverPromise;
    return resolver(req);
  }

  function sendDomainError(res: Response, error: unknown, next: NextFunction): void {
    if (error instanceof CardDomainError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    next(error);
  }

  async function requireAdmin(req: Request, res: Response): Promise<AuthenticatedActor | null> {
    const actor = await resolveActor(req);
    if (!actor) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Sesi tidak valid. Silakan masuk terlebih dahulu.' },
      });
      return null;
    }
    if (actor.role !== 'admin') {
      res.status(403).json({
        error: { code: 'FORBIDDEN_ROLE', message: 'Hanya admin yang dapat mengelola verifikasi kartu digital.' },
      });
      return null;
    }
    return actor;
  }

  type AdminHandler = (req: Request, res: Response, actor: AuthenticatedActor) => Promise<void>;
  const adminOnly = (handler: AdminHandler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await requireAdmin(req, res);
      if (actor) await handler(req, res, actor);
    } catch (error) {
      sendDomainError(res, error, next);
    }
  };

  router.use('/admin/card-applications', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/admin/card-applications — Antrean, pencarian nama/nomor kartu, & filter status (PBI-19, PBI-20)
  router.get('/admin/card-applications', adminOnly(async (req, res) => {
    const query = adminCardListQuerySchema.parse(withoutEmptyValues(req.query));
    const result = await getStore().listForAdmin(query);
    res.json({ data: result });
  }));

  // GET /api/admin/card-applications/:id — Detail pengajuan, dokumen, kartu terbit, & riwayat peninjauan
  router.get('/admin/card-applications/:id', adminOnly(async (req, res) => {
    const { id } = uuidParam.parse(req.params);
    const application = await getStore().getById(id);
    if (!application) {
      throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
    }
    res.json({ data: application });
  }));

  // GET /api/admin/card-applications/:id/documents/:documentId — Pratinjau dokumen pendukung oleh admin
  router.get('/admin/card-applications/:id/documents/:documentId', adminOnly(async (req, res) => {
    const { id, documentId } = documentParams.parse(req.params);
    const document = await getStore().getDocumentForAdmin(id, documentId);
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
  }));

  // POST /api/admin/card-applications/:id/decision — Keputusan verifikasi & penerbitan kartu + QR
  router.post('/admin/card-applications/:id/decision', adminOnly(async (req, res, actor) => {
    const { id } = uuidParam.parse(req.params);
    const input = adminDecisionSchema.parse(req.body ?? {});
    const result = await getStore().transitionStatus(toActor(actor), id, {
      status: input.decision,
      reason: input.reason,
      validityMonths: input.validityMonths,
    });
    res.json({
      data: result.application,
      notification: result.notification,
      idempotent: result.idempotent,
    });
  }));

  // POST /api/admin/card-applications/:id/renew — Perpanjang masa berlaku kartu aktif
  router.post('/admin/card-applications/:id/renew', adminOnly(async (req, res, actor) => {
    const { id } = uuidParam.parse(req.params);
    const input = renewCardSchema.parse(req.body ?? {});
    const result = await getStore().renew(toActor(actor), id, input);
    res.json({
      data: result.application,
      notification: result.notification,
    });
  }));

  // POST /api/admin/card-applications/:id/revoke — Cabut kartu aktif dengan konfirmasi & alasan
  router.post('/admin/card-applications/:id/revoke', adminOnly(async (req, res, actor) => {
    const { id } = uuidParam.parse(req.params);
    const input = revokeCardSchema.parse(req.body ?? {});
    const result = await getStore().transitionStatus(toActor(actor), id, {
      status: 'dicabut',
      reason: input.reason,
    });
    res.json({
      data: result.application,
      notification: result.notification,
      idempotent: result.idempotent,
    });
  }));

  // GET /api/card-applications/:id/qr — Render QR SVG untuk pemilik kartu atau admin
  router.get('/card-applications/:id/qr', async (req, res, next) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Sesi tidak valid. Silakan masuk terlebih dahulu.' },
        });
        return;
      }

      const { id } = uuidParam.parse(req.params);
      const application = await getStore().getById(id);
      if (!application) {
        throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
      }
      if (application.userId !== actor.id && actor.role !== 'admin') {
        throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke QR kartu ini.');
      }
      if (!application.issuedCard) {
        throw new CardDomainError(409, 'CARD_NOT_ISSUED', 'Kartu digital belum diterbitkan.');
      }

      const svg = await renderVerifyQrSvg(application.issuedCard.qrToken, options?.publicBaseUrl);

      res.set({
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(svg);
    } catch (error) {
      sendDomainError(res, error, next);
    }
  });

  // GET /api/cards/verify/:token/qr — Render QR SVG publik sesuai token verifikasi
  router.get('/cards/verify/:token/qr', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const { token } = qrTokenParam.parse(req.params);
      const lookup = await getStore().findByQrToken(token);
      if (!lookup) {
        res.status(404).json({
          error: { code: 'CARD_NOT_FOUND', message: 'Kartu digital tidak ditemukan atau kode QR tidak valid.' },
        });
        return;
      }

      const svg = await renderVerifyQrSvg(token, options?.publicBaseUrl);
      res.set({
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(svg);
    } catch (error) {
      sendDomainError(res, error, next);
    }
  });

  // GET /api/cards/verify/:token — Verifikasi publik QR kartu (payload terbatas, tanpa dokumen sensitif)
  router.get('/cards/verify/:token', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const { token } = qrTokenParam.parse(req.params);
      const lookup = await getStore().findByQrToken(token);
      if (!lookup) {
        res.status(404).json({
          error: { code: 'CARD_NOT_FOUND', message: 'Kartu digital tidak ditemukan atau kode QR tidak valid.' },
        });
        return;
      }
      res.json({ data: formatPublicVerification(lookup) });
    } catch (error) {
      sendDomainError(res, error, next);
    }
  });

  return router;
}

export const adminCardApplicationsRouter = createAdminCardApplicationsRouter();
