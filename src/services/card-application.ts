import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';

export const CARD_STATUSES = [
  'pending',
  'diproses',
  'perbaikan',
  'verified',
  'rejected',
  'dicabut',
  'dibatalkan',
] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

export const DISABILITY_CATEGORIES = [
  'fisik',
  'sensorik_netra',
  'sensorik_runguwicara',
  'intelektual',
  'mental',
  'ganda_lainnya',
] as const;

export type DisabilityCategory = (typeof DISABILITY_CATEGORIES)[number];

export const ACCESSIBILITY_NEEDS = [
  'step_free',
  'priority_seating',
  'audio',
  'visual',
  'companion',
  'other',
] as const;

export type AccessibilityNeed = (typeof ACCESSIBILITY_NEEDS)[number];

export const DOCUMENT_TYPES = [
  'surat_keterangan',
  'kartu_komunitas',
  'dokumen_pendukung_lain',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const ALLOWED_DOCUMENT_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedDocumentMime = (typeof ALLOWED_DOCUMENT_MIMES)[number];

export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface StatusMetadata {
  status: CardStatus;
  label: string;
  badgeTone: 'active' | 'warning' | 'danger' | 'neutral';
  canEdit: boolean;
  canCancel: boolean;
  notificationTitle: string;
  defaultMessage: string;
}

export const CARD_STATUS_METADATA: Record<CardStatus, StatusMetadata> = {
  pending: {
    status: 'pending',
    label: 'Menunggu peninjauan',
    badgeTone: 'neutral',
    canEdit: true,
    canCancel: true,
    notificationTitle: 'Pengajuan kartu diterima',
    defaultMessage: 'Pengajuan Digital Accessibility Card kamu telah diterima dan menunggu peninjauan.',
  },
  diproses: {
    status: 'diproses',
    label: 'Sedang diproses',
    badgeTone: 'active',
    canEdit: false,
    canCancel: true,
    notificationTitle: 'Pengajuan kartu sedang diproses',
    defaultMessage: 'Tim verifikasi sedang memeriksa data dan dokumen pengajuan kartumu.',
  },
  perbaikan: {
    status: 'perbaikan',
    label: 'Butuh perbaikan dokumen',
    badgeTone: 'warning',
    canEdit: true,
    canCancel: true,
    notificationTitle: 'Pengajuan kartu membutuhkan perbaikan',
    defaultMessage: 'Mohon perbarui data atau unggah ulang dokumen pendukung sesuai catatan peninjau.',
  },
  verified: {
    status: 'verified',
    label: 'Terverifikasi',
    badgeTone: 'active',
    canEdit: false,
    canCancel: false,
    notificationTitle: 'Digital Accessibility Card disetujui',
    defaultMessage: 'Selamat! Pengajuan Digital Accessibility Card kamu telah disetujui dan aktif.',
  },
  rejected: {
    status: 'rejected',
    label: 'Ditolak',
    badgeTone: 'danger',
    canEdit: false,
    canCancel: false,
    notificationTitle: 'Pengajuan kartu belum disetujui',
    defaultMessage: 'Pengajuan Digital Accessibility Card kamu belum dapat disetujui. Periksa detail alasan pada halaman kartu.',
  },
  dicabut: {
    status: 'dicabut',
    label: 'Dicabut',
    badgeTone: 'danger',
    canEdit: false,
    canCancel: false,
    notificationTitle: 'Status Digital Accessibility Card dicabut',
    defaultMessage: 'Status verifikasi Digital Accessibility Card kamu telah dicabut. Lihat detail pada halaman kartu.',
  },
  dibatalkan: {
    status: 'dibatalkan',
    label: 'Dibatalkan',
    badgeTone: 'neutral',
    canEdit: false,
    canCancel: false,
    notificationTitle: 'Pengajuan kartu dibatalkan',
    defaultMessage: 'Pengajuan Digital Accessibility Card telah dibatalkan dan dokumen pendukung ditarik.',
  },
};

export const VALID_STATUS_TRANSITIONS: Record<CardStatus, readonly CardStatus[]> = {
  pending: ['diproses', 'perbaikan', 'verified', 'rejected', 'dibatalkan'],
  diproses: ['perbaikan', 'verified', 'rejected', 'dibatalkan'],
  perbaikan: ['pending', 'diproses', 'verified', 'rejected', 'dibatalkan'],
  verified: ['dicabut'],
  rejected: [],
  dicabut: [],
  dibatalkan: [],
};

export function canEditCardApplication(status: CardStatus): boolean {
  return CARD_STATUS_METADATA[status].canEdit;
}

export function canCancelCardApplication(status: CardStatus): boolean {
  return CARD_STATUS_METADATA[status].canCancel;
}

export function isValidStatusTransition(from: CardStatus, to: CardStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from].includes(to);
}

// Validation Schemas (Zod)
export const documentUploadSchema = z.strictObject({
  documentType: z.enum(DOCUMENT_TYPES, {
    message: 'Pilih jenis dokumen pendukung yang valid.',
  }),
  fileName: z
    .string()
    .trim()
    .min(1, 'Nama berkas dokumen wajib diisi.')
    .max(255, 'Nama berkas maksimal 255 karakter.')
    .refine((name) => !/[<>:"/\\|?*\x00-\x1F]/.test(name), 'Nama berkas mengandung karakter tidak valid.'),
  mimeType: z.enum(ALLOWED_DOCUMENT_MIMES, {
    message: 'Format dokumen harus berupa PDF, JPG, PNG, atau WebP.',
  }),
  fileSize: z
    .number()
    .int()
    .min(1, 'Berkas dokumen tidak boleh kosong.')
    .max(MAX_DOCUMENT_SIZE_BYTES, 'Ukuran berkas maksimal 5 MB.'),
  contentBase64: z
    .string()
    .trim()
    .min(4, 'Isi dokumen pendukung wajib diunggah.')
    .max(7_500_000, 'Ukuran payload dokumen melebihi batas 5 MB.')
    .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Format enkoding dokumen tidak valid.'),
}).refine(
  (document) => Buffer.from(document.contentBase64, 'base64').length === document.fileSize,
  { message: 'Ukuran dokumen tidak sesuai dengan isi berkas.', path: ['fileSize'] },
);

const documentsSchema = z.array(documentUploadSchema)
  .min(1, 'Unggah minimal satu dokumen pendukung.')
  .max(3, 'Unggah maksimal tiga dokumen pendukung.');

export const createCardApplicationSchema = z.strictObject({
  fullName: z
    .string()
    .trim()
    .min(2, 'Nama lengkap minimal 2 karakter.')
    .max(100, 'Nama lengkap maksimal 100 karakter.'),
  disabilityCategory: z.enum(DISABILITY_CATEGORIES, {
    message: 'Pilih kategori disabilitas yang valid.',
  }),
  needs: z
    .array(z.enum(ACCESSIBILITY_NEEDS))
    .max(6, 'Pilih maksimal 6 kebutuhan aksesibilitas.')
    .default([])
    .transform((items) => Array.from(new Set(items))),
  notes: z
    .string()
    .trim()
    .max(500, 'Catatan tambahan maksimal 500 karakter.')
    .default(''),
  consentGiven: z.boolean().refine((val) => val === true, {
    message: 'Anda wajib menyetujui pemrosesan data dan dokumen pendukung.',
  }),
  document: documentUploadSchema.optional(),
  documents: documentsSchema.optional(),
}).refine(
  (input) => Boolean(input.document) !== Boolean(input.documents),
  { message: 'Unggah satu hingga tiga dokumen pendukung.', path: ['documents'] },
);

export const updateCardApplicationSchema = z
  .strictObject({
    fullName: z
      .string()
      .trim()
      .min(2, 'Nama lengkap minimal 2 karakter.')
      .max(100, 'Nama lengkap maksimal 100 karakter.')
      .optional(),
    disabilityCategory: z
      .enum(DISABILITY_CATEGORIES, {
        message: 'Pilih kategori disabilitas yang valid.',
      })
      .optional(),
    needs: z
      .array(z.enum(ACCESSIBILITY_NEEDS))
      .max(6, 'Pilih maksimal 6 kebutuhan aksesibilitas.')
      .transform((items) => Array.from(new Set(items)))
      .optional(),
    notes: z
      .string()
      .trim()
      .max(500, 'Catatan tambahan maksimal 500 karakter.')
      .optional(),
    consentGiven: z.boolean().refine((val) => val === true, {
      message: 'Persetujuan penggunaan data tidak boleh dicabut selama pengajuan aktif.',
    }),
    document: documentUploadSchema.optional(),
    documents: documentsSchema.optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
  })
  .refine((input) => !(input.document && input.documents), {
    message: 'Kirim dokumen dalam satu format payload.',
    path: ['documents'],
  })
  .refine(
    (data) =>
      data.fullName !== undefined ||
      data.disabilityCategory !== undefined ||
      data.needs !== undefined ||
      data.notes !== undefined ||
      data.document !== undefined ||
      data.documents !== undefined ||
      data.documentType !== undefined,
    { message: 'Minimal satu data atau dokumen harus diperbarui.' },
  );

export const statusTransitionSchema = z.strictObject({
  status: z.enum(['diproses', 'perbaikan', 'verified', 'rejected', 'dicabut'], {
    message: 'Status tujuan tidak valid.',
  }),
  reason: z
    .string()
    .trim()
    .max(500, 'Catatan verifikasi maksimal 500 karakter.')
    .default(''),
}).refine(
  (input) =>
    (input.status !== 'perbaikan' && input.status !== 'rejected' && input.status !== 'dicabut') ||
    input.reason.length >= 5,
  {
    path: ['reason'],
    message: 'Alasan atau catatan wajib diisi (minimal 5 karakter) untuk status perbaikan, ditolak, atau dicabut.',
  },
);

export interface CardEvidenceRecord {
  id: string;
  cardId: string;
  userId: string;
  documentType: DocumentType;
  fileName: string;
  mimeType: AllowedDocumentMime;
  fileSize: number;
  filePath: string;
  uploadedAt: string;
}

export interface CardVerificationRecord {
  id: string;
  cardId: string;
  actorId: string | null;
  previousStatus: CardStatus | null;
  newStatus: CardStatus;
  reason: string;
  createdAt: string;
}

export interface CardApplicationRecord {
  id: string;
  userId: string;
  fullName: string;
  disabilityCategory: DisabilityCategory;
  needs: AccessibilityNeed[];
  notes: string;
  consentGiven: boolean;
  consentAt: string;
  status: CardStatus;
  statusLabel: string;
  canEdit: boolean;
  canCancel: boolean;
  reviewerNote: string;
  submittedAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  cancelledAt: string | null;
  evidence: CardEvidenceRecord | null;
  documents: CardEvidenceRecord[];
  history: CardVerificationRecord[];
}

export interface CardNotificationRecord {
  id: string;
  userId: string;
  cardId: string;
  status: CardStatus;
  statusLabel: string;
  title: string;
  message: string;
  deepLink: string;
  dedupKey: string;
  isRead: boolean;
  createdAt: string;
  readAt: string | null;
}

export class CardDomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CardDomainError';
    this.status = status;
    this.code = code;
  }
}

export function buildStatusNotificationPayload(
  cardId: string,
  userId: string,
  previousStatus: CardStatus | null,
  newStatus: CardStatus,
  reason: string,
  updatedAtIso: string,
): Omit<CardNotificationRecord, 'id' | 'isRead' | 'createdAt' | 'readAt'> {
  const meta = CARD_STATUS_METADATA[newStatus];
  const cleanReason = reason.trim();
  const message = cleanReason
    ? `${meta.defaultMessage} Catatan: ${cleanReason}`
    : meta.defaultMessage;

  // Deterministic deduplication key per transition signature
  const dedupRaw = `${cardId}:${previousStatus ?? 'none'}->${newStatus}:${cleanReason}:${updatedAtIso.slice(0, 19)}`;
  const dedupKey = createHash('sha256').update(dedupRaw).digest('hex').slice(0, 40);

  return {
    userId,
    cardId,
    status: newStatus,
    statusLabel: meta.label,
    title: meta.notificationTitle,
    message: message.slice(0, 500),
    deepLink: `/kartu-aksesibilitas#pengajuan-${cardId}`,
    dedupKey,
  };
}

export function enrichCardRecord(
  raw: Omit<CardApplicationRecord, 'statusLabel' | 'canEdit' | 'canCancel'>,
): CardApplicationRecord {
  const meta = CARD_STATUS_METADATA[raw.status];
  return {
    ...raw,
    statusLabel: meta.label,
    canEdit: meta.canEdit,
    canCancel: meta.canCancel,
  };
}

export interface CardApplicationStore {
  listByUser(userId: string): Promise<CardApplicationRecord[]>;
  getById(cardId: string): Promise<CardApplicationRecord | null>;
  getDocument(
    userId: string,
    cardId: string,
    documentId: string,
  ): Promise<{ mimeType: AllowedDocumentMime; content: Uint8Array } | null>;
  create(
    userId: string,
    input: z.infer<typeof createCardApplicationSchema>,
  ): Promise<{ application: CardApplicationRecord; notification: CardNotificationRecord }>;
  update(
    userId: string,
    cardId: string,
    input: z.infer<typeof updateCardApplicationSchema>,
  ): Promise<{ application: CardApplicationRecord; notification: CardNotificationRecord | null }>;
  cancel(
    userId: string,
    cardId: string,
  ): Promise<{ application: CardApplicationRecord; notification: CardNotificationRecord }>;
  transitionStatus(
    actorId: string,
    cardId: string,
    input: z.infer<typeof statusTransitionSchema>,
  ): Promise<{
    application: CardApplicationRecord;
    notification: CardNotificationRecord | null;
    idempotent: boolean;
  }>;
  listNotifications(userId: string): Promise<CardNotificationRecord[]>;
  markNotificationRead(userId: string, notificationId: string): Promise<CardNotificationRecord>;
  markAllNotificationsRead(userId: string): Promise<number>;
}

/**
 * In-memory store implementation for unit/integration tests and local fallback,
 * enforcing identical constraints, ownership, and idempotency rules as PostgreSQL.
 */
function buildEvidenceRecord(
  document: z.infer<typeof documentUploadSchema>,
  userId: string,
  cardId: string,
  uploadedAt: string,
): CardEvidenceRecord {
  const id = randomUUID();
  return {
    id,
    userId,
    cardId,
    documentType: document.documentType,
    fileName: document.fileName,
    mimeType: document.mimeType,
    fileSize: document.fileSize,
    filePath: `private://card-evidence/${userId}/${cardId}/${id}`,
    uploadedAt,
  };
}

async function insertEvidence(
  tx: Prisma.TransactionClient,
  userId: string,
  cardId: string,
  documents: z.infer<typeof documentUploadSchema>[],
) {
  for (const document of documents) {
    const evidence = buildEvidenceRecord(document, userId, cardId, new Date().toISOString());
    await tx.$executeRaw`
      WITH evidence AS (
        INSERT INTO public.card_evidence (
          id, card_id, user_id, document_type, file_name, mime_type, file_size, file_path
        ) VALUES (
          ${evidence.id}::uuid, ${cardId}::uuid, ${userId}::uuid, ${document.documentType},
          ${document.fileName}, ${document.mimeType}, ${document.fileSize}, ${evidence.filePath}
        )
        RETURNING id
      )
      INSERT INTO aksesin_private.card_evidence_contents (evidence_id, content)
      SELECT id, ${Buffer.from(document.contentBase64, 'base64')}::bytea FROM evidence`;
  }
}

export function createInMemoryCardStore(): CardApplicationStore {
  const cards = new Map<string, Omit<CardApplicationRecord, 'statusLabel' | 'canEdit' | 'canCancel'>>();
  const documentContents = new Map<string, Uint8Array>();
  const notifications = new Map<string, CardNotificationRecord>();
  const dedupIndex = new Map<string, CardNotificationRecord>();

  function emitNotification(
    cardId: string,
    userId: string,
    previousStatus: CardStatus | null,
    newStatus: CardStatus,
    reason: string,
    timestampIso: string,
  ): { notification: CardNotificationRecord; created: boolean } {
    const payload = buildStatusNotificationPayload(
      cardId,
      userId,
      previousStatus,
      newStatus,
      reason,
      timestampIso,
    );
    const existing = dedupIndex.get(payload.dedupKey);
    if (existing) {
      return { notification: existing, created: false };
    }
    const record: CardNotificationRecord = {
      id: randomUUID(),
      ...payload,
      isRead: false,
      createdAt: timestampIso,
      readAt: null,
    };
    notifications.set(record.id, record);
    dedupIndex.set(record.dedupKey, record);
    return { notification: record, created: true };
  }

  return {
    async listByUser(userId: string) {
      return Array.from(cards.values())
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(enrichCardRecord);
    },

    async getById(cardId: string) {
      const card = cards.get(cardId);
      return card ? enrichCardRecord(card) : null;
    },

    async getDocument(userId, cardId, documentId) {
      const card = cards.get(cardId);
      if (card?.userId !== userId) return null;
      const document = card.documents.find((item) => item.id === documentId);
      const content = documentContents.get(documentId);
      return document && content ? { mimeType: document.mimeType, content } : null;
    },

    async create(userId, input) {
      const activeStatuses: CardStatus[] = ['pending', 'diproses', 'perbaikan', 'verified'];
      const hasActive = Array.from(cards.values()).some(
        (c) => c.userId === userId && activeStatuses.includes(c.status),
      );
      if (hasActive) {
        throw new CardDomainError(
          409,
          'ACTIVE_APPLICATION_EXISTS',
          'Anda sudah memiliki pengajuan Digital Accessibility Card yang sedang aktif.',
        );
      }

      const now = new Date().toISOString();
      const cardId = randomUUID();
      const documents = (input.documents ?? (input.document ? [input.document] : []))
        .map((document) => {
          const evidence = buildEvidenceRecord(document, userId, cardId, now);
          documentContents.set(evidence.id, Buffer.from(document.contentBase64, 'base64'));
          return evidence;
        });

      const historyEntry: CardVerificationRecord = {
        id: randomUUID(),
        cardId,
        actorId: userId,
        previousStatus: null,
        newStatus: 'pending',
        reason: 'Pengajuan baru dikirim oleh pengguna.',
        createdAt: now,
      };

      const rawCard: Omit<CardApplicationRecord, 'statusLabel' | 'canEdit' | 'canCancel'> = {
        id: cardId,
        userId,
        fullName: input.fullName,
        disabilityCategory: input.disabilityCategory,
        needs: input.needs,
        notes: input.notes,
        consentGiven: input.consentGiven,
        consentAt: now,
        status: 'pending',
        reviewerNote: '',
        submittedAt: now,
        updatedAt: now,
        verifiedAt: null,
        cancelledAt: null,
        evidence: documents[0] ?? null,
        documents,
        history: [historyEntry],
      };

      cards.set(cardId, rawCard);
      const { notification } = emitNotification(cardId, userId, null, 'pending', '', now);

      return { application: enrichCardRecord(rawCard), notification };
    },

    async update(userId, cardId, input) {
      const card = cards.get(cardId);
      if (!card) {
        throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
      }
      if (card.userId !== userId) {
        throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke data pengajuan ini.');
      }
      if (!canEditCardApplication(card.status)) {
        throw new CardDomainError(
          409,
          'STATUS_NOT_EDITABLE',
          'Pengajuan hanya dapat diperbarui saat berstatus menunggu peninjauan atau butuh perbaikan.',
        );
      }

      const now = new Date().toISOString();
      const previousStatus = card.status;
      const nextStatus: CardStatus = card.status === 'perbaikan' ? 'pending' : card.status;

      if (input.fullName !== undefined) card.fullName = input.fullName;
      if (input.disabilityCategory !== undefined) card.disabilityCategory = input.disabilityCategory;
      if (input.needs !== undefined) card.needs = input.needs;
      if (input.notes !== undefined) card.notes = input.notes;

      const documents = input.documents ?? (input.document ? [input.document] : []);
      if (documents.length > 0) {
        for (const document of card.documents) documentContents.delete(document.id);
        card.documents = documents.map((document) => {
          const evidence = buildEvidenceRecord(document, userId, cardId, now);
          documentContents.set(evidence.id, Buffer.from(document.contentBase64, 'base64'));
          return evidence;
        });
        card.evidence = card.documents[0] ?? null;
      } else if (input.documentType) {
        for (const document of card.documents) document.documentType = input.documentType;
      }

      card.status = nextStatus;
      card.updatedAt = now;

      let notification: CardNotificationRecord | null = null;
      if (previousStatus !== nextStatus) {
        card.history.unshift({
          id: randomUUID(),
          cardId,
          actorId: userId,
          previousStatus,
          newStatus: nextStatus,
          reason: 'Perbaikan dokumen/data telah dikirim ulang oleh pengguna.',
          createdAt: now,
        });
        notification = emitNotification(
          cardId,
          userId,
          previousStatus,
          nextStatus,
          'Perbaikan dokumen telah diterima dan menunggu peninjauan ulang.',
          now,
        ).notification;
      }

      return { application: enrichCardRecord(card), notification };
    },

    async cancel(userId, cardId) {
      const card = cards.get(cardId);
      if (!card) {
        throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
      }
      if (card.userId !== userId) {
        throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke data pengajuan ini.');
      }
      if (!canCancelCardApplication(card.status)) {
        throw new CardDomainError(
          409,
          'STATUS_NOT_CANCELLABLE',
          'Pengajuan yang sudah selesai diverifikasi atau dibatalkan tidak dapat dibatalkan kembali.',
        );
      }

      const now = new Date().toISOString();
      const previousStatus = card.status;
      card.status = 'dibatalkan';
      card.cancelledAt = now;
      card.updatedAt = now;
      card.evidence = null;
      for (const document of card.documents) documentContents.delete(document.id);
      card.documents = [];

      card.history.unshift({
        id: randomUUID(),
        cardId,
        actorId: userId,
        previousStatus,
        newStatus: 'dibatalkan',
        reason: 'Dibatalkan oleh pengguna.',
        createdAt: now,
      });

      const { notification } = emitNotification(
        cardId,
        userId,
        previousStatus,
        'dibatalkan',
        'Pengajuan dibatalkan atas permintaanmu.',
        now,
      );

      return { application: enrichCardRecord(card), notification };
    },

    async transitionStatus(actorId, cardId, input) {
      const card = cards.get(cardId);
      if (!card) {
        throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
      }

      const previousStatus = card.status;
      const targetStatus = input.status;
      const cleanReason = input.reason.trim();

      // Idempotency check: if already in the target status with the same reviewer note, do not duplicate notification
      if (previousStatus === targetStatus && card.reviewerNote === cleanReason) {
        return {
          application: enrichCardRecord(card),
          notification: null,
          idempotent: true,
        };
      }

      if (!isValidStatusTransition(previousStatus, targetStatus)) {
        throw new CardDomainError(
          409,
          'INVALID_STATUS_TRANSITION',
          `Perubahan status dari '${CARD_STATUS_METADATA[previousStatus].label}' ke '${CARD_STATUS_METADATA[targetStatus].label}' tidak diizinkan.`,
        );
      }

      const now = new Date().toISOString();
      card.status = targetStatus;
      card.reviewerNote = cleanReason;
      card.updatedAt = now;
      if (targetStatus === 'verified') {
        card.verifiedAt = now;
      }

      card.history.unshift({
        id: randomUUID(),
        cardId,
        actorId,
        previousStatus,
        newStatus: targetStatus,
        reason: cleanReason,
        createdAt: now,
      });

      const { notification, created } = emitNotification(
        cardId,
        card.userId,
        previousStatus,
        targetStatus,
        cleanReason,
        now,
      );

      return {
        application: enrichCardRecord(card),
        notification: created ? notification : null,
        idempotent: !created,
      };
    },

    async listNotifications(userId) {
      return Array.from(notifications.values())
        .filter((n) => n.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async markNotificationRead(userId, notificationId) {
      const notif = notifications.get(notificationId);
      if (!notif) {
        throw new CardDomainError(404, 'NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
      }
      if (notif.userId !== userId) {
        throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke notifikasi ini.');
      }
      if (!notif.isRead) {
        notif.isRead = true;
        notif.readAt = new Date().toISOString();
      }
      return notif;
    },

    async markAllNotificationsRead(userId) {
      const now = new Date().toISOString();
      let count = 0;
      for (const notif of notifications.values()) {
        if (notif.userId === userId && !notif.isRead) {
          notif.isRead = true;
          notif.readAt = now;
          count += 1;
        }
      }
      return count;
    },
  };
}

let schemaInitializedPromise: Promise<void> | null = null;

export async function ensureCardTablesExist(): Promise<void> {
  if (schemaInitializedPromise) return schemaInitializedPromise;

  schemaInitializedPromise = (async () => {
    const db = getPrisma();
    const statements = [
      `create table if not exists public.digital_cards (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        full_name text not null check (char_length(full_name) between 1 and 100),
        disability_category text not null check (
          disability_category in ('fisik', 'sensorik_netra', 'sensorik_runguwicara', 'intelektual', 'mental', 'ganda_lainnya')
        ),
        needs text[] not null default '{}' check (
          cardinality(needs) <= 6
          and array_position(needs, null) is null
          and needs <@ array['step_free', 'priority_seating', 'audio', 'visual', 'companion', 'other']::text[]
        ),
        notes text not null default '' check (char_length(notes) <= 500),
        consent_given boolean not null check (consent_given = true),
        consent_at timestamptz not null default now(),
        status text not null default 'pending' check (
          status in ('pending', 'diproses', 'perbaikan', 'verified', 'rejected', 'dicabut', 'dibatalkan')
        ),
        reviewer_note text not null default '' check (char_length(reviewer_note) <= 500),
        submitted_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        verified_at timestamptz,
        cancelled_at timestamptz
      )`,
      `create unique index if not exists digital_cards_one_active_per_user_idx
        on public.digital_cards (user_id)
        where status in ('pending', 'diproses', 'perbaikan', 'verified')`,
      `create index if not exists digital_cards_user_updated_idx
        on public.digital_cards (user_id, updated_at desc)`,
      `create table if not exists public.card_evidence (
        id uuid primary key default gen_random_uuid(),
        card_id uuid not null references public.digital_cards(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        document_type text not null check (
          document_type in ('surat_keterangan', 'kartu_komunitas', 'dokumen_pendukung_lain')
        ),
        file_name text not null check (char_length(file_name) between 1 and 255),
        mime_type text not null check (
          mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
        ),
        file_size integer not null check (file_size between 1 and 5242880),
        file_path text not null check (char_length(file_path) >= 1),
        uploaded_at timestamptz not null default now()
      )`,
      `create index if not exists card_evidence_card_idx on public.card_evidence (card_id)`,
      `create table if not exists public.card_verifications (
        id uuid primary key default gen_random_uuid(),
        card_id uuid not null references public.digital_cards(id) on delete cascade,
        actor_id uuid references auth.users(id) on delete set null,
        previous_status text,
        new_status text not null check (
          new_status in ('pending', 'diproses', 'perbaikan', 'verified', 'rejected', 'dicabut', 'dibatalkan')
        ),
        reason text not null default '' check (char_length(reason) <= 500),
        created_at timestamptz not null default now()
      )`,
      `create index if not exists card_verifications_card_idx on public.card_verifications (card_id, created_at desc)`,
      `create table if not exists public.card_notifications (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        card_id uuid not null references public.digital_cards(id) on delete cascade,
        status text not null check (
          status in ('pending', 'diproses', 'perbaikan', 'verified', 'rejected', 'dicabut', 'dibatalkan')
        ),
        title text not null check (char_length(title) between 1 and 160),
        message text not null check (char_length(message) between 1 and 500),
        deep_link text not null default '/kartu-aksesibilitas',
        dedup_key text not null unique,
        is_read boolean not null default false,
        created_at timestamptz not null default now(),
        read_at timestamptz
      )`,
      `create index if not exists card_notifications_user_created_idx on public.card_notifications (user_id, created_at desc)`,
      `alter table public.digital_cards enable row level security`,
      `alter table public.card_evidence enable row level security`,
      `alter table public.card_verifications enable row level security`,
      `alter table public.card_notifications enable row level security`,
      `grant select, insert, update on public.digital_cards to authenticated`,
      `grant select on public.card_evidence to authenticated`,
      `grant select on public.card_verifications to authenticated`,
      `grant select, insert, update on public.card_notifications to authenticated`,
      `drop policy if exists "Read own digital cards" on public.digital_cards`,
      `create policy "Read own digital cards" on public.digital_cards for select to authenticated using ((select auth.uid()) = user_id)`,
      `drop policy if exists "Insert own digital card" on public.digital_cards`,
      `create policy "Insert own digital card" on public.digital_cards for insert to authenticated with check ((select auth.uid()) = user_id and consent_given = true and status = 'pending')`,
      `drop policy if exists "Update own digital card before verification finishes" on public.digital_cards`,
      `create policy "Update own digital card before verification finishes" on public.digital_cards for update to authenticated using ((select auth.uid()) = user_id and status in ('pending', 'diproses', 'perbaikan')) with check ((select auth.uid()) = user_id and status in ('pending', 'perbaikan', 'dibatalkan'))`,
      `drop policy if exists "Read own card evidence" on public.card_evidence`,
      `create policy "Read own card evidence" on public.card_evidence for select to authenticated using ((select auth.uid()) = user_id)`,
      `drop policy if exists "Insert own card evidence" on public.card_evidence`,
      `drop policy if exists "Delete own card evidence" on public.card_evidence`,
      `drop policy if exists "Read own card verification history" on public.card_verifications`,
      `create policy "Read own card verification history" on public.card_verifications for select to authenticated using (exists (select 1 from public.digital_cards c where c.id = card_verifications.card_id and c.user_id = (select auth.uid())))`,
      `drop policy if exists "Read own card notifications" on public.card_notifications`,
      `create policy "Read own card notifications" on public.card_notifications for select to authenticated using ((select auth.uid()) = user_id)`,
      `drop policy if exists "Insert own card notifications" on public.card_notifications`,
      `create policy "Insert own card notifications" on public.card_notifications for insert to authenticated with check ((select auth.uid()) = user_id)`,
      `drop policy if exists "Mark own card notifications as read" on public.card_notifications`,
      `create policy "Mark own card notifications as read" on public.card_notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)`,
      `notify pgrst, 'reload schema'`,
    ];

    for (const sql of statements) {
      await db.$executeRawUnsafe(sql);
    }
  })().catch((err) => {
    schemaInitializedPromise = null;
    throw err;
  });

  return schemaInitializedPromise;
}

/**
 * Prisma/PostgreSQL backed store for production/development with Supabase PostgreSQL.
 */
export function createPrismaCardStore(): CardApplicationStore {
  type DbCardRow = {
    id: string;
    user_id: string;
    full_name: string;
    disability_category: DisabilityCategory;
    needs: AccessibilityNeed[];
    notes: string;
    consent_given: boolean;
    consent_at: Date;
    status: CardStatus;
    reviewer_note: string;
    submitted_at: Date;
    updated_at: Date;
    verified_at: Date | null;
    cancelled_at: Date | null;
  };

  type DbEvidenceRow = {
    id: string;
    card_id: string;
    user_id: string;
    document_type: DocumentType;
    file_name: string;
    mime_type: AllowedDocumentMime;
    file_size: number;
    file_path: string;
    uploaded_at: Date;
  };

  type DbVerificationRow = {
    id: string;
    card_id: string;
    actor_id: string | null;
    previous_status: CardStatus | null;
    new_status: CardStatus;
    reason: string;
    created_at: Date;
  };

  type DbNotificationRow = {
    id: string;
    user_id: string;
    card_id: string;
    status: CardStatus;
    title: string;
    message: string;
    deep_link: string;
    dedup_key: string;
    is_read: boolean;
    created_at: Date;
    read_at: Date | null;
  };

  function mapNotification(row: DbNotificationRow): CardNotificationRecord {
    return {
      id: row.id,
      userId: row.user_id,
      cardId: row.card_id,
      status: row.status,
      statusLabel: CARD_STATUS_METADATA[row.status].label,
      title: row.title,
      message: row.message,
      deepLink: row.deep_link,
      dedupKey: row.dedup_key,
      isRead: row.is_read,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at ? row.read_at.toISOString() : null,
    };
  }

  async function hydrateCard(row: DbCardRow): Promise<CardApplicationRecord> {
    const db = getPrisma();
    const evidenceRows = await db.$queryRaw<DbEvidenceRow[]>`
      SELECT id, card_id, user_id, document_type, file_name, mime_type, file_size, file_path, uploaded_at
      FROM public.card_evidence
      WHERE card_id = ${row.id}::uuid
      ORDER BY uploaded_at DESC, id`;

    const historyRows = await db.$queryRaw<DbVerificationRow[]>`
      SELECT id, card_id, actor_id, previous_status, new_status, reason, created_at
      FROM public.card_verifications
      WHERE card_id = ${row.id}::uuid
      ORDER BY created_at DESC`;

    const documents = evidenceRows.map((evidenceRow) => ({
      id: evidenceRow.id,
      cardId: evidenceRow.card_id,
      userId: evidenceRow.user_id,
      documentType: evidenceRow.document_type,
      fileName: evidenceRow.file_name,
      mimeType: evidenceRow.mime_type,
      fileSize: evidenceRow.file_size,
      filePath: evidenceRow.file_path,
      uploadedAt: evidenceRow.uploaded_at.toISOString(),
    }));

    return enrichCardRecord({
      id: row.id,
      userId: row.user_id,
      fullName: row.full_name,
      disabilityCategory: row.disability_category,
      needs: row.needs ?? [],
      notes: row.notes,
      consentGiven: row.consent_given,
      consentAt: row.consent_at.toISOString(),
      status: row.status,
      reviewerNote: row.reviewer_note,
      submittedAt: row.submitted_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
      cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
      evidence: documents[0] ?? null,
      documents,
      history: historyRows.map((h) => ({
        id: h.id,
        cardId: h.card_id,
        actorId: h.actor_id,
        previousStatus: h.previous_status,
        newStatus: h.new_status,
        reason: h.reason,
        createdAt: h.created_at.toISOString(),
      })),
    });
  }

  return {
    async listByUser(userId: string) {
      await ensureCardTablesExist();
      const db = getPrisma();
      const rows = await db.$queryRaw<DbCardRow[]>`
        SELECT * FROM public.digital_cards
        WHERE user_id = ${userId}::uuid
        ORDER BY updated_at DESC`;
      return Promise.all(rows.map(hydrateCard));
    },

    async getById(cardId: string) {
      await ensureCardTablesExist();
      const db = getPrisma();
      const [row] = await db.$queryRaw<DbCardRow[]>`
        SELECT * FROM public.digital_cards WHERE id = ${cardId}::uuid`;
      return row ? hydrateCard(row) : null;
    },

    async getDocument(userId, cardId, documentId) {
      const [document] = await getPrisma().$queryRaw<{ mimeType: AllowedDocumentMime; content: Uint8Array }[]>`
        SELECT evidence.mime_type AS "mimeType", contents.content
        FROM public.card_evidence AS evidence
        JOIN aksesin_private.card_evidence_contents AS contents ON contents.evidence_id = evidence.id
        JOIN public.digital_cards AS card ON card.id = evidence.card_id
        WHERE evidence.id = ${documentId}::uuid
          AND evidence.card_id = ${cardId}::uuid
          AND evidence.user_id = ${userId}::uuid
          AND card.user_id = ${userId}::uuid
          AND card.status <> 'dibatalkan'`;
      return document ?? null;
    },

    async create(userId, input) {
      await ensureCardTablesExist();
      const db = getPrisma();
      const result = await db.$transaction(async (tx) => {
        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM public.digital_cards
          WHERE user_id = ${userId}::uuid
            AND status IN ('pending', 'diproses', 'perbaikan', 'verified')
          LIMIT 1 FOR UPDATE`;
        if (existing.length > 0) {
          throw new CardDomainError(
            409,
            'ACTIVE_APPLICATION_EXISTS',
            'Anda sudah memiliki pengajuan Digital Accessibility Card yang sedang aktif.',
          );
        }

        const [cardRow] = await tx.$queryRaw<DbCardRow[]>`
          INSERT INTO public.digital_cards (
            user_id, full_name, disability_category, needs, notes, consent_given, status
          ) VALUES (
            ${userId}::uuid,
            ${input.fullName},
            ${input.disabilityCategory},
            ${input.needs}::text[],
            ${input.notes},
            ${input.consentGiven},
            'pending'
          )
          RETURNING *`;
        if (!cardRow) {
          throw new CardDomainError(500, 'CREATE_FAILED', 'Gagal menyimpan pengajuan kartu.');
        }

        await insertEvidence(tx, userId, cardRow.id, input.documents ?? (input.document ? [input.document] : []));

        await tx.$executeRaw`
          INSERT INTO public.card_verifications (
            card_id, actor_id, previous_status, new_status, reason
          ) VALUES (
            ${cardRow.id}::uuid,
            ${userId}::uuid,
            NULL,
            'pending',
            'Pengajuan baru dikirim oleh pengguna.'
          )`;

        const payload = buildStatusNotificationPayload(
          cardRow.id,
          userId,
          null,
          'pending',
          '',
          cardRow.updated_at.toISOString(),
        );

        const [notifRow] = await tx.$queryRaw<DbNotificationRow[]>`
          INSERT INTO public.card_notifications (
            user_id, card_id, status, title, message, deep_link, dedup_key
          ) VALUES (
            ${userId}::uuid,
            ${cardRow.id}::uuid,
            'pending',
            ${payload.title},
            ${payload.message},
            ${payload.deepLink},
            ${payload.dedupKey}
          )
          RETURNING *`;
        if (!notifRow) {
          throw new CardDomainError(500, 'NOTIFICATION_FAILED', 'Gagal mencatat notifikasi pengajuan.');
        }

        return { cardRow, notifRow };
      });

      return {
        application: await hydrateCard(result.cardRow),
        notification: mapNotification(result.notifRow),
      };
    },

    async update(userId, cardId, input) {
      const db = getPrisma();
      const result = await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<DbCardRow[]>`
          SELECT * FROM public.digital_cards WHERE id = ${cardId}::uuid FOR UPDATE`;
        if (!current) {
          throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
        }
        if (current.user_id !== userId) {
          throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke data pengajuan ini.');
        }
        if (!canEditCardApplication(current.status)) {
          throw new CardDomainError(
            409,
            'STATUS_NOT_EDITABLE',
            'Pengajuan hanya dapat diperbarui saat berstatus menunggu peninjauan atau butuh perbaikan.',
          );
        }

        const nextStatus: CardStatus = current.status === 'perbaikan' ? 'pending' : current.status;
        const fullName = input.fullName ?? current.full_name;
        const disabilityCategory = input.disabilityCategory ?? current.disability_category;
        const needs = input.needs ?? current.needs;
        const notes = input.notes ?? current.notes;

        const [updatedRow] = await tx.$queryRaw<DbCardRow[]>`
          UPDATE public.digital_cards
          SET full_name = ${fullName},
              disability_category = ${disabilityCategory},
              needs = ${needs}::text[],
              notes = ${notes},
              status = ${nextStatus},
              updated_at = now()
          WHERE id = ${cardId}::uuid
          RETURNING *`;
        if (!updatedRow) {
          throw new CardDomainError(500, 'UPDATE_FAILED', 'Gagal memperbarui pengajuan kartu.');
        }

        const documents = input.documents ?? (input.document ? [input.document] : []);
        if (documents.length > 0) {
          await tx.$executeRaw`DELETE FROM public.card_evidence WHERE card_id = ${cardId}::uuid`;
          await insertEvidence(tx, userId, cardId, documents);
        } else if (input.documentType) {
          await tx.$executeRaw`
            UPDATE public.card_evidence SET document_type = ${input.documentType}
            WHERE card_id = ${cardId}::uuid AND user_id = ${userId}::uuid`;
        }

        let notifRow: DbNotificationRow | null = null;
        if (current.status !== nextStatus) {
          await tx.$executeRaw`
            INSERT INTO public.card_verifications (
              card_id, actor_id, previous_status, new_status, reason
            ) VALUES (
              ${cardId}::uuid,
              ${userId}::uuid,
              ${current.status},
              ${nextStatus},
              'Perbaikan dokumen/data telah dikirim ulang oleh pengguna.'
            )`;

          const payload = buildStatusNotificationPayload(
            cardId,
            userId,
            current.status,
            nextStatus,
            'Perbaikan dokumen telah diterima dan menunggu peninjauan ulang.',
            updatedRow.updated_at.toISOString(),
          );

          const [insertedNotif] = await tx.$queryRaw<DbNotificationRow[]>`
            INSERT INTO public.card_notifications (
              user_id, card_id, status, title, message, deep_link, dedup_key
            ) VALUES (
              ${userId}::uuid,
              ${cardId}::uuid,
              ${nextStatus},
              ${payload.title},
              ${payload.message},
              ${payload.deepLink},
              ${payload.dedupKey}
            )
            ON CONFLICT (dedup_key) DO NOTHING
            RETURNING *`;
          notifRow = insertedNotif ?? null;
        }

        return { updatedRow, notifRow };
      });

      return {
        application: await hydrateCard(result.updatedRow),
        notification: result.notifRow ? mapNotification(result.notifRow) : null,
      };
    },

    async cancel(userId, cardId) {
      const db = getPrisma();
      const result = await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<DbCardRow[]>`
          SELECT * FROM public.digital_cards WHERE id = ${cardId}::uuid FOR UPDATE`;
        if (!current) {
          throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
        }
        if (current.user_id !== userId) {
          throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke data pengajuan ini.');
        }
        if (!canCancelCardApplication(current.status)) {
          throw new CardDomainError(
            409,
            'STATUS_NOT_CANCELLABLE',
            'Pengajuan yang sudah selesai diverifikasi atau dibatalkan tidak dapat dibatalkan kembali.',
          );
        }

        await tx.$executeRaw`DELETE FROM public.card_evidence WHERE card_id = ${cardId}::uuid`;

        const [updatedRow] = await tx.$queryRaw<DbCardRow[]>`
          UPDATE public.digital_cards
          SET status = 'dibatalkan',
              cancelled_at = now(),
              updated_at = now()
          WHERE id = ${cardId}::uuid
          RETURNING *`;
        if (!updatedRow) {
          throw new CardDomainError(500, 'CANCEL_FAILED', 'Gagal membatalkan pengajuan kartu.');
        }

        await tx.$executeRaw`
          INSERT INTO public.card_verifications (
            card_id, actor_id, previous_status, new_status, reason
          ) VALUES (
            ${cardId}::uuid,
            ${userId}::uuid,
            ${current.status},
            'dibatalkan',
            'Dibatalkan oleh pengguna.'
          )`;

        const payload = buildStatusNotificationPayload(
          cardId,
          userId,
          current.status,
          'dibatalkan',
          'Pengajuan dibatalkan atas permintaanmu.',
          updatedRow.updated_at.toISOString(),
        );

        const [notifRow] = await tx.$queryRaw<DbNotificationRow[]>`
          INSERT INTO public.card_notifications (
            user_id, card_id, status, title, message, deep_link, dedup_key
          ) VALUES (
            ${userId}::uuid,
            ${cardId}::uuid,
            'dibatalkan',
            ${payload.title},
            ${payload.message},
            ${payload.deepLink},
            ${payload.dedupKey}
          )
          RETURNING *`;
        if (!notifRow) {
          throw new CardDomainError(500, 'NOTIFICATION_FAILED', 'Gagal mencatat notifikasi pembatalan.');
        }

        return { updatedRow, notifRow };
      });

      return {
        application: await hydrateCard(result.updatedRow),
        notification: mapNotification(result.notifRow),
      };
    },

    async transitionStatus(actorId, cardId, input) {
      const db = getPrisma();
      const result = await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<DbCardRow[]>`
          SELECT * FROM public.digital_cards WHERE id = ${cardId}::uuid FOR UPDATE`;
        if (!current) {
          throw new CardDomainError(404, 'APPLICATION_NOT_FOUND', 'Data pengajuan kartu tidak ditemukan.');
        }

        const cleanReason = input.reason.trim();
        if (current.status === input.status && current.reviewer_note === cleanReason) {
          return { updatedRow: current, notifRow: null, idempotent: true };
        }

        if (!isValidStatusTransition(current.status, input.status)) {
          throw new CardDomainError(
            409,
            'INVALID_STATUS_TRANSITION',
            `Perubahan status dari '${CARD_STATUS_METADATA[current.status].label}' ke '${CARD_STATUS_METADATA[input.status].label}' tidak diizinkan.`,
          );
        }

        const [updatedRow] = await tx.$queryRaw<DbCardRow[]>`
          UPDATE public.digital_cards
          SET status = ${input.status},
              reviewer_note = ${cleanReason},
              verified_at = CASE WHEN ${input.status} = 'verified' THEN now() ELSE verified_at END,
              updated_at = now()
          WHERE id = ${cardId}::uuid
          RETURNING *`;
        if (!updatedRow) {
          throw new CardDomainError(500, 'STATUS_UPDATE_FAILED', 'Gagal memperbarui status pengajuan.');
        }

        await tx.$executeRaw`
          INSERT INTO public.card_verifications (
            card_id, actor_id, previous_status, new_status, reason
          ) VALUES (
            ${cardId}::uuid,
            ${actorId}::uuid,
            ${current.status},
            ${input.status},
            ${cleanReason}
          )`;

        const payload = buildStatusNotificationPayload(
          cardId,
          current.user_id,
          current.status,
          input.status,
          cleanReason,
          updatedRow.updated_at.toISOString(),
        );

        const [notifRow] = await tx.$queryRaw<DbNotificationRow[]>`
          INSERT INTO public.card_notifications (
            user_id, card_id, status, title, message, deep_link, dedup_key
          ) VALUES (
            ${current.user_id}::uuid,
            ${cardId}::uuid,
            ${input.status},
            ${payload.title},
            ${payload.message},
            ${payload.deepLink},
            ${payload.dedupKey}
          )
          ON CONFLICT (dedup_key) DO NOTHING
          RETURNING *`;

        return { updatedRow, notifRow: notifRow ?? null, idempotent: !notifRow };
      });

      return {
        application: await hydrateCard(result.updatedRow),
        notification: result.notifRow ? mapNotification(result.notifRow) : null,
        idempotent: result.idempotent,
      };
    },

    async listNotifications(userId) {
      await ensureCardTablesExist();
      const db = getPrisma();
      const rows = await db.$queryRaw<DbNotificationRow[]>`
        SELECT * FROM public.card_notifications
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
        LIMIT 50`;
      return rows.map(mapNotification);
    },

    async markNotificationRead(userId, notificationId) {
      const db = getPrisma();
      const [current] = await db.$queryRaw<DbNotificationRow[]>`
        SELECT * FROM public.card_notifications WHERE id = ${notificationId}::uuid`;
      if (!current) {
        throw new CardDomainError(404, 'NOTIFICATION_NOT_FOUND', 'Notifikasi tidak ditemukan.');
      }
      if (current.user_id !== userId) {
        throw new CardDomainError(403, 'FORBIDDEN_ACCESS', 'Anda tidak memiliki akses ke notifikasi ini.');
      }
      const [updated] = await db.$queryRaw<DbNotificationRow[]>`
        UPDATE public.card_notifications
        SET is_read = true, read_at = COALESCE(read_at, now())
        WHERE id = ${notificationId}::uuid
        RETURNING *`;
      if (!updated) {
        throw new CardDomainError(500, 'UPDATE_FAILED', 'Gagal memperbarui status baca notifikasi.');
      }
      return mapNotification(updated);
    },

    async markAllNotificationsRead(userId) {
      const db = getPrisma();
      const rows = await db.$queryRaw<{ id: string }[]>`
        UPDATE public.card_notifications
        SET is_read = true, read_at = now()
        WHERE user_id = ${userId}::uuid AND is_read = false
        RETURNING id`;
      return rows.length;
    },
  };
}
