import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { getPrisma } from '../lib/prisma.js';
import {
  ACCESSIBILITY_ATTRIBUTE_KEYS,
  ACCESSIBILITY_STATUSES,
  JAKARTA_BOUNDS,
  PLACE_LIMITS,
  PLACE_SOURCES,
  approximateDistanceMeters,
  hasPlaceChanged,
  mapOsmElement,
  normalizePlaceName,
  osmElementSchema,
  osmKey,
  type AccessibilityAttributes,
  type AccessibilityStatus,
  type MappedPlace,
  type OsmType,
  type PlaceSource,
  type SkipReason,
} from './osm-mapping.js';
import { OverpassUnavailableError, type OverpassFetcher } from './overpass.js';

export const IMPORT_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const EXCLUSION_REASONS = ['duplicate', 'invalid'] as const;

export const IMPORT_MESSAGES = {
  overpassUnavailable: 'Overpass API sedang tidak dapat diakses. Data tempat yang tersimpan tidak diubah. Coba lagi beberapa saat lagi.',
  emptyResponse: 'Overpass tidak mengembalikan data tempat. Data tempat yang tersimpan tidak diubah.',
  failed: 'Impor gagal diproses. Data tempat yang tersimpan tidak diubah.',
  interrupted: 'Impor terhenti karena server dimulai ulang.',
} as const;

const IMPORT_BATCH_SIZE = 500;
const DUPLICATE_DISTANCE_METERS = 50;

export class PlaceImportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PlaceImportError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Kontrak data
// ---------------------------------------------------------------------------

export type SkipBreakdown = Partial<Record<SkipReason, number>>;

export interface ImportJobRecord {
  id: string;
  triggeredBy: string | null;
  status: ImportJobStatus;
  area: string;
  startedAt: string | null;
  finishedAt: string | null;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  skipBreakdown: SkipBreakdown;
  errorMessage: string | null;
  sourceEndpoint: string | null;
  createdAt: string;
}

export interface ImportResultCounts {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  skipBreakdown: SkipBreakdown;
}

export interface PlaceRecord {
  id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  accessibilityStatus: AccessibilityStatus;
  accessibilityAttributes: AccessibilityAttributes;
  dataSource: PlaceSource;
  osmType: OsmType | null;
  osmId: number | null;
  editedByAdmin: boolean;
  sourceUpdatedAt: string | null;
  lastImportedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  savedCount: number;
  contributionCount: number;
}

export interface DuplicateCandidate {
  distanceMeters: number;
  places: [PlaceRecord, PlaceRecord];
}

export interface AdminNotificationRecord {
  id: string;
  type: 'osm_import_succeeded' | 'osm_import_failed';
  jobId: string | null;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApplyImportResult {
  created: number;
  updated: number;
  unchanged: number;
  excluded: number;
  editedByAdmin: number;
}

export interface DeletePlaceResult {
  id: string;
  name: string;
  dataSource: PlaceSource;
  excluded: boolean;
  savedByCount: number;
  contributionCount: number;
}

// ---------------------------------------------------------------------------
// Validasi input (dipakai router)
// ---------------------------------------------------------------------------

export const uuidParamSchema = z.strictObject({ id: z.uuid({ message: 'ID tidak valid.' }) });

export const jobListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

export const placeListQuerySchema = z.strictObject({
  q: z.string().trim().max(100, 'Kata kunci maksimal 100 karakter.').optional(),
  status: z.enum(ACCESSIBILITY_STATUSES, { message: 'Status aksesibilitas tidak dikenal.' }).optional(),
  source: z.enum(PLACE_SOURCES, { message: 'Sumber data tidak dikenal.' }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100, 'Maksimal 100 tempat per halaman.').default(20),
});
export type PlaceListQuery = z.infer<typeof placeListQuerySchema>;

export const notificationQuerySchema = z.strictObject({
  unread: z.enum(['true', 'false']).optional(),
});

export const deletePlaceSchema = z.strictObject({
  reason: z.enum(EXCLUSION_REASONS).optional(),
});

const coordinateMessage = 'Koordinat harus berada di wilayah daratan Jakarta.';

export const updatePlaceSchema = z.strictObject({
  name: z.string().trim().min(1, 'Nama tempat wajib diisi.').max(PLACE_LIMITS.name, 'Nama maksimal 200 karakter.').optional(),
  category: z.string().trim().max(PLACE_LIMITS.category, 'Kategori maksimal 80 karakter.').optional(),
  address: z.string().trim().max(PLACE_LIMITS.address, 'Alamat maksimal 300 karakter.').optional(),
  latitude: z.number().min(JAKARTA_BOUNDS.minLat, coordinateMessage).max(JAKARTA_BOUNDS.maxLat, coordinateMessage).optional(),
  longitude: z.number().min(JAKARTA_BOUNDS.minLon, coordinateMessage).max(JAKARTA_BOUNDS.maxLon, coordinateMessage).optional(),
  accessibilityStatus: z.enum(ACCESSIBILITY_STATUSES, { message: 'Status aksesibilitas tidak dikenal.' }).optional(),
  accessibilityAttributes: z.partialRecord(
    z.enum(ACCESSIBILITY_ATTRIBUTE_KEYS),
    z.string().trim().max(PLACE_LIMITS.attribute, 'Nilai atribut maksimal 500 karakter.'),
  ).optional(),
})
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Tidak ada perubahan yang dikirim.',
  })
  .refine((value) => (value.latitude === undefined) === (value.longitude === undefined), {
    message: 'Latitude dan longitude harus diisi bersamaan.',
    path: ['latitude'],
  });
export type UpdatePlaceInput = z.infer<typeof updatePlaceSchema>;

function cleanAttributes(attributes: Partial<Record<string, string | undefined>>): AccessibilityAttributes {
  const result: AccessibilityAttributes = {};
  for (const key of ACCESSIBILITY_ATTRIBUTE_KEYS) {
    const value = attributes[key]?.trim();
    if (value) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PlaceImportStore {
  createJob(triggeredBy: string): Promise<ImportJobRecord>;
  getJob(id: string): Promise<ImportJobRecord | null>;
  listJobs(page: number, pageSize: number): Promise<Page<ImportJobRecord>>;
  markJobRunning(id: string): Promise<boolean>;
  completeJob(id: string, counts: ImportResultCounts, endpoint: string): Promise<void>;
  failJob(id: string, message: string): Promise<void>;
  failInterruptedJobs(message: string): Promise<number>;
  applyImport(places: MappedPlace[]): Promise<ApplyImportResult>;
  listPlaces(query: PlaceListQuery): Promise<Page<PlaceRecord>>;
  findDuplicateCandidates(limit: number): Promise<DuplicateCandidate[]>;
  updatePlace(id: string, patch: UpdatePlaceInput): Promise<PlaceRecord | null>;
  deletePlace(id: string, actorId: string, reason: string): Promise<DeletePlaceResult | null>;
  listNotifications(unreadOnly: boolean): Promise<{ items: AdminNotificationRecord[]; unreadCount: number }>;
  markNotificationRead(id: string): Promise<AdminNotificationRecord | null>;
}

const activeJobConflict = () => new PlaceImportError(
  409,
  'IMPORT_ALREADY_RUNNING',
  'Impor OSM masih berjalan. Tunggu sampai selesai sebelum menjalankan impor baru.',
);

export function buildImportNotification(job: ImportJobRecord): Pick<AdminNotificationRecord, 'type' | 'title' | 'message'> {
  if (job.status === 'succeeded') {
    return {
      type: 'osm_import_succeeded',
      title: 'Impor OSM berhasil',
      message: `${job.fetchedCount} data diambil dari OSM: ${job.createdCount} baru, ${job.updatedCount} diperbarui, `
        + `${job.unchangedCount} tidak berubah, ${job.skippedCount} dilewati.`,
    };
  }
  return {
    type: 'osm_import_failed',
    title: 'Impor OSM gagal',
    message: (job.errorMessage ?? IMPORT_MESSAGES.failed).slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Store in-memory: untuk test, mengikuti aturan yang sama dengan PostgreSQL
// ---------------------------------------------------------------------------

export interface SeedPlaceInput {
  name: string;
  category?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  dataSource?: PlaceSource;
  osmType?: OsmType;
  osmId?: number;
  accessibilityStatus?: AccessibilityStatus;
  accessibilityAttributes?: AccessibilityAttributes;
}

export interface InMemoryPlaceImportStore extends PlaceImportStore {
  seedPlace(input: SeedPlaceInput): PlaceRecord;
  setUsage(placeId: string, usage: { saved?: number; contributions?: number }): void;
  allPlaces(): PlaceRecord[];
  allNotifications(): AdminNotificationRecord[];
  exclusionKeys(): string[];
}

export function createInMemoryPlaceImportStore(): InMemoryPlaceImportStore {
  const places = new Map<string, Omit<PlaceRecord, 'savedCount' | 'contributionCount'>>();
  const usage = new Map<string, { saved: number; contributions: number }>();
  const jobs: ImportJobRecord[] = [];
  const notifications: AdminNotificationRecord[] = [];
  const exclusions = new Set<string>();

  const now = () => new Date().toISOString();
  const withUsage = (place: Omit<PlaceRecord, 'savedCount' | 'contributionCount'>): PlaceRecord => ({
    ...structuredClone(place),
    savedCount: usage.get(place.id)?.saved ?? 0,
    contributionCount: usage.get(place.id)?.contributions ?? 0,
  });

  function findOsmPlace(osmType: OsmType, osmId: number) {
    for (const place of places.values()) {
      if (place.osmType === osmType && place.osmId === osmId) return place;
    }
    return undefined;
  }

  function finish(job: ImportJobRecord) {
    const payload = buildImportNotification(job);
    if (notifications.some((item) => item.jobId === job.id && item.type === payload.type)) return;
    notifications.unshift({ id: randomUUID(), jobId: job.id, isRead: false, createdAt: now(), readAt: null, ...payload });
  }

  return {
    seedPlace(input) {
      const timestamp = now();
      const record = {
        id: randomUUID(),
        name: input.name,
        category: input.category ?? '',
        address: input.address ?? '',
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        accessibilityStatus: input.accessibilityStatus ?? 'unknown',
        accessibilityAttributes: input.accessibilityAttributes ?? {},
        dataSource: input.dataSource ?? 'manual',
        osmType: input.osmType ?? null,
        osmId: input.osmId ?? null,
        editedByAdmin: false,
        sourceUpdatedAt: null,
        lastImportedAt: null,
        editedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      places.set(record.id, record);
      return withUsage(record);
    },

    setUsage(placeId, value) {
      usage.set(placeId, { saved: value.saved ?? 0, contributions: value.contributions ?? 0 });
    },

    allPlaces: () => [...places.values()].map(withUsage),
    allNotifications: () => structuredClone(notifications),
    exclusionKeys: () => [...exclusions],

    async createJob(triggeredBy) {
      if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) throw activeJobConflict();
      const job: ImportJobRecord = {
        id: randomUUID(),
        triggeredBy,
        status: 'queued',
        area: 'DKI Jakarta',
        startedAt: null,
        finishedAt: null,
        fetchedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        skipBreakdown: {},
        errorMessage: null,
        sourceEndpoint: null,
        createdAt: now(),
      };
      jobs.unshift(job);
      return structuredClone(job);
    },

    async getJob(id) {
      const job = jobs.find((item) => item.id === id);
      return job ? structuredClone(job) : null;
    },

    async listJobs(page, pageSize) {
      const start = (page - 1) * pageSize;
      return { items: structuredClone(jobs.slice(start, start + pageSize)), total: jobs.length, page, pageSize };
    },

    async markJobRunning(id) {
      const job = jobs.find((item) => item.id === id && item.status === 'queued');
      if (!job) return false;
      job.status = 'running';
      job.startedAt = now();
      return true;
    },

    async completeJob(id, counts, endpoint) {
      const job = jobs.find((item) => item.id === id && item.status === 'running');
      if (!job) return;
      Object.assign(job, counts, { status: 'succeeded', finishedAt: now(), sourceEndpoint: endpoint, errorMessage: null });
      finish(job);
    },

    async failJob(id, message) {
      const job = jobs.find((item) => item.id === id && (item.status === 'queued' || item.status === 'running'));
      if (!job) return;
      Object.assign(job, { status: 'failed', finishedAt: now(), errorMessage: message });
      finish(job);
    },

    async failInterruptedJobs(message) {
      const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
      for (const job of active) {
        Object.assign(job, { status: 'failed', finishedAt: now(), errorMessage: message });
        finish(job);
      }
      return active.length;
    },

    async applyImport(incoming) {
      const result: ApplyImportResult = { created: 0, updated: 0, unchanged: 0, excluded: 0, editedByAdmin: 0 };
      for (const place of incoming) {
        if (exclusions.has(osmKey(place.osmType, place.osmId))) {
          result.excluded += 1;
          continue;
        }
        const timestamp = now();
        const existing = findOsmPlace(place.osmType, place.osmId);
        if (!existing) {
          const id = randomUUID();
          places.set(id, {
            ...structuredClone(place),
            id,
            dataSource: 'osm',
            editedByAdmin: false,
            lastImportedAt: timestamp,
            editedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          result.created += 1;
        } else if (existing.dataSource !== 'osm' || existing.editedByAdmin) {
          result.editedByAdmin += 1;
        } else if (hasPlaceChanged(comparable(existing), place)) {
          Object.assign(existing, structuredClone(place), { lastImportedAt: timestamp, updatedAt: timestamp });
          result.updated += 1;
        } else {
          existing.lastImportedAt = timestamp;
          result.unchanged += 1;
        }
      }
      return result;
    },

    async listPlaces(query) {
      const keyword = query.q?.toLowerCase();
      const filtered = [...places.values()]
        .filter((place) => !keyword || place.name.toLowerCase().includes(keyword))
        .filter((place) => !query.status || place.accessibilityStatus === query.status)
        .filter((place) => !query.source || place.dataSource === query.source)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize).map(withUsage),
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async findDuplicateCandidates(limit) {
      const located = [...places.values()].filter((place) => place.latitude !== null && place.longitude !== null);
      const pairs: DuplicateCandidate[] = [];
      for (let i = 0; i < located.length; i += 1) {
        for (let j = i + 1; j < located.length; j += 1) {
          const a = located[i]!;
          const b = located[j]!;
          if (normalizePlaceName(a.name) !== normalizePlaceName(b.name)) continue;
          const distance = approximateDistanceMeters(a.latitude!, a.longitude!, b.latitude!, b.longitude!);
          if (distance < DUPLICATE_DISTANCE_METERS) {
            const [first, second] = a.id < b.id ? [a, b] : [b, a];
            pairs.push({ distanceMeters: Math.round(distance * 10) / 10, places: [withUsage(first), withUsage(second)] });
          }
        }
      }
      return pairs.sort((x, y) => x.distanceMeters - y.distanceMeters).slice(0, limit);
    },

    async updatePlace(id, patch) {
      const place = places.get(id);
      if (!place) return null;
      const { accessibilityAttributes, ...fields } = patch;
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) Object.assign(place, { [key]: value });
      }
      if (accessibilityAttributes) place.accessibilityAttributes = cleanAttributes(accessibilityAttributes);
      const timestamp = now();
      Object.assign(place, { editedByAdmin: true, editedAt: timestamp, updatedAt: timestamp });
      return withUsage(place);
    },

    async deletePlace(id, _actorId, _reason) {
      const place = places.get(id);
      if (!place) return null;
      const counts = usage.get(id) ?? { saved: 0, contributions: 0 };
      const excluded = place.osmType !== null && place.osmId !== null;
      if (excluded) exclusions.add(osmKey(place.osmType!, place.osmId!));
      places.delete(id);
      usage.delete(id);
      return {
        id,
        name: place.name,
        dataSource: place.dataSource,
        excluded,
        savedByCount: counts.saved,
        contributionCount: counts.contributions,
      };
    },

    async listNotifications(unreadOnly) {
      return {
        items: structuredClone(notifications.filter((item) => !unreadOnly || !item.isRead).slice(0, 50)),
        unreadCount: notifications.filter((item) => !item.isRead).length,
      };
    },

    async markNotificationRead(id) {
      const notification = notifications.find((item) => item.id === id);
      if (!notification) return null;
      if (!notification.isRead) Object.assign(notification, { isRead: true, readAt: now() });
      return structuredClone(notification);
    },
  };
}

function comparable(place: {
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  accessibilityStatus: AccessibilityStatus;
  accessibilityAttributes: AccessibilityAttributes;
  sourceUpdatedAt: string | null;
}) {
  return {
    ...place,
    // Koordinat kosong selalu dianggap berbeda dari koordinat hasil impor.
    latitude: place.latitude ?? Number.POSITIVE_INFINITY,
    longitude: place.longitude ?? Number.POSITIVE_INFINITY,
  };
}

// ---------------------------------------------------------------------------
// Store PostgreSQL (Supabase) dengan raw SQL berparameter
// ---------------------------------------------------------------------------

type JobRow = {
  id: string;
  triggered_by: string | null;
  status: ImportJobStatus;
  area: string;
  started_at: Date | null;
  finished_at: Date | null;
  fetched_count: number;
  created_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_count: number;
  skip_breakdown: SkipBreakdown | null;
  error_message: string | null;
  source_endpoint: string | null;
  created_at: Date;
};

type PlaceRow = {
  id: string;
  name: string;
  category: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  accessibility_status: AccessibilityStatus;
  accessibility_attributes: AccessibilityAttributes | null;
  data_source: PlaceSource;
  osm_type: OsmType | null;
  osm_id: bigint | number | string | null;
  edited_by_admin: boolean;
  source_updated_at: Date | null;
  last_imported_at: Date | null;
  edited_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type NotificationRow = {
  id: string;
  type: AdminNotificationRecord['type'];
  job_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  created_at: Date;
  read_at: Date | null;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function mapJob(row: JobRow): ImportJobRecord {
  return {
    id: row.id,
    triggeredBy: row.triggered_by,
    status: row.status,
    area: row.area,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    fetchedCount: row.fetched_count,
    createdCount: row.created_count,
    updatedCount: row.updated_count,
    unchangedCount: row.unchanged_count,
    skippedCount: row.skipped_count,
    skipBreakdown: row.skip_breakdown ?? {},
    errorMessage: row.error_message,
    sourceEndpoint: row.source_endpoint,
    createdAt: row.created_at.toISOString(),
  };
}

function mapPlace(row: PlaceRow, counts?: { saved: number; contributions: number }): PlaceRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    accessibilityStatus: row.accessibility_status,
    accessibilityAttributes: row.accessibility_attributes ?? {},
    dataSource: row.data_source,
    osmType: row.osm_type,
    osmId: row.osm_id === null ? null : Number(row.osm_id),
    editedByAdmin: row.edited_by_admin,
    sourceUpdatedAt: iso(row.source_updated_at),
    lastImportedAt: iso(row.last_imported_at),
    editedAt: iso(row.edited_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    savedCount: counts?.saved ?? 0,
    contributionCount: counts?.contributions ?? 0,
  };
}

function mapNotification(row: NotificationRow): AdminNotificationRecord {
  return {
    id: row.id,
    type: row.type,
    jobId: row.job_id,
    title: row.title,
    message: row.message,
    isRead: row.is_read,
    createdAt: row.created_at.toISOString(),
    readAt: iso(row.read_at),
  };
}

function rowComparable(row: PlaceRow) {
  return comparable({
    name: row.name,
    category: row.category,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    accessibilityStatus: row.accessibility_status,
    accessibilityAttributes: row.accessibility_attributes ?? {},
    sourceUpdatedAt: iso(row.source_updated_at),
  });
}

function placePayload(batch: MappedPlace[]): string {
  return JSON.stringify(batch.map((place) => ({
    osm_type: place.osmType,
    osm_id: place.osmId,
    name: place.name,
    category: place.category,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    accessibility_status: place.accessibilityStatus,
    accessibility_attributes: place.accessibilityAttributes,
    source_updated_at: place.sourceUpdatedAt,
  })));
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function describeDatabaseError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = error as { code?: unknown; message?: unknown; meta?: unknown };
  return `${String(value.code ?? '')} ${String(value.message ?? '')} ${JSON.stringify(value.meta ?? {})}`;
}

function isUniqueViolation(error: unknown): boolean {
  return /23505|P2002|unique/i.test(describeDatabaseError(error));
}

// Migration belum diterapkan: balas 503 yang jelas, bukan 500.
export function toPlaceImportError(error: unknown): PlaceImportError | null {
  if (error instanceof PlaceImportError) return error;
  if (/42P01|42703|does not exist/i.test(describeDatabaseError(error))) {
    return new PlaceImportError(503, 'IMPORT_SCHEMA_MISSING', 'Skema impor OSM belum diterapkan di database.');
  }
  return null;
}

async function insertJobNotification(tx: Prisma.TransactionClient, row: JobRow): Promise<void> {
  const payload = buildImportNotification(mapJob(row));
  await tx.$executeRaw`
    INSERT INTO public.admin_notifications (type, job_id, title, message)
    VALUES (${payload.type}, ${row.id}::uuid, ${payload.title}, ${payload.message})
    ON CONFLICT (job_id, type) WHERE job_id IS NOT NULL DO NOTHING`;
}

export function createPrismaPlaceImportStore(): PlaceImportStore {
  let contributionsTablePromise: Promise<boolean> | null = null;

  // accessibility_contributions dibuat oleh modul lain dan bisa belum ada di database.
  function hasContributionsTable(): Promise<boolean> {
    contributionsTablePromise ??= getPrisma()
      .$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.accessibility_contributions') IS NOT NULL AS present`
      .then((rows) => Boolean(rows[0]?.present))
      .catch((error: unknown) => {
        contributionsTablePromise = null;
        throw error;
      });
    return contributionsTablePromise;
  }

  async function usageFor(ids: string[]): Promise<Map<string, { saved: number; contributions: number }>> {
    const result = new Map(ids.map((id) => [id, { saved: 0, contributions: 0 }]));
    if (!ids.length) return result;
    const db = getPrisma();
    const saved = await db.$queryRaw<{ place_id: string; n: number }[]>`
      SELECT place_id, count(*)::int AS n FROM public.saved_places
      WHERE place_id = ANY(${ids}::uuid[]) GROUP BY place_id`;
    for (const row of saved) result.get(row.place_id)!.saved = row.n;
    if (await hasContributionsTable()) {
      const contributions = await db.$queryRaw<{ place_id: string; n: number }[]>`
        SELECT place_id, count(*)::int AS n FROM public.accessibility_contributions
        WHERE place_id = ANY(${ids}::uuid[]) GROUP BY place_id`;
      for (const row of contributions) result.get(row.place_id)!.contributions = row.n;
    }
    return result;
  }

  async function withUsage(rows: PlaceRow[]): Promise<PlaceRecord[]> {
    const counts = await usageFor(rows.map((row) => row.id));
    return rows.map((row) => mapPlace(row, counts.get(row.id)));
  }

  return {
    async createJob(triggeredBy) {
      const db = getPrisma();
      const active = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM public.place_import_jobs WHERE status IN ('queued', 'running') LIMIT 1`;
      if (active.length) throw activeJobConflict();
      try {
        const [row] = await db.$queryRaw<JobRow[]>`
          INSERT INTO public.place_import_jobs (triggered_by) VALUES (${triggeredBy}::uuid) RETURNING *`;
        if (!row) throw new PlaceImportError(500, 'IMPORT_CREATE_FAILED', 'Job impor belum dapat dibuat.');
        return mapJob(row);
      } catch (error) {
        // Unique index parsial menolak job kedua yang dibuat bersamaan.
        if (isUniqueViolation(error)) throw activeJobConflict();
        throw error;
      }
    },

    async getJob(id) {
      const [row] = await getPrisma().$queryRaw<JobRow[]>`
        SELECT * FROM public.place_import_jobs WHERE id = ${id}::uuid`;
      return row ? mapJob(row) : null;
    },

    async listJobs(page, pageSize) {
      const db = getPrisma();
      const offset = (page - 1) * pageSize;
      const rows = await db.$queryRaw<JobRow[]>`
        SELECT * FROM public.place_import_jobs
        ORDER BY created_at DESC, id DESC
        LIMIT ${pageSize}::int OFFSET ${offset}::int`;
      const [count] = await db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM public.place_import_jobs`;
      return { items: rows.map(mapJob), total: count?.total ?? 0, page, pageSize };
    },

    async markJobRunning(id) {
      const rows = await getPrisma().$queryRaw<{ id: string }[]>`
        UPDATE public.place_import_jobs SET status = 'running', started_at = now()
        WHERE id = ${id}::uuid AND status = 'queued' RETURNING id`;
      return rows.length > 0;
    },

    async completeJob(id, counts, endpoint) {
      await getPrisma().$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<JobRow[]>`
          UPDATE public.place_import_jobs SET
            status = 'succeeded',
            finished_at = now(),
            fetched_count = ${counts.fetchedCount}::int,
            created_count = ${counts.createdCount}::int,
            updated_count = ${counts.updatedCount}::int,
            unchanged_count = ${counts.unchangedCount}::int,
            skipped_count = ${counts.skippedCount}::int,
            skip_breakdown = ${JSON.stringify(counts.skipBreakdown)}::jsonb,
            source_endpoint = ${endpoint},
            error_message = NULL
          WHERE id = ${id}::uuid AND status = 'running'
          RETURNING *`;
        if (row) await insertJobNotification(tx, row);
      });
    },

    async failJob(id, message) {
      await getPrisma().$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<JobRow[]>`
          UPDATE public.place_import_jobs
          SET status = 'failed', finished_at = now(), error_message = ${message}
          WHERE id = ${id}::uuid AND status IN ('queued', 'running')
          RETURNING *`;
        if (row) await insertJobNotification(tx, row);
      });
    },

    async failInterruptedJobs(message) {
      return getPrisma().$transaction(async (tx) => {
        const rows = await tx.$queryRaw<JobRow[]>`
          UPDATE public.place_import_jobs
          SET status = 'failed', finished_at = now(), error_message = ${message}
          WHERE status IN ('queued', 'running')
          RETURNING *`;
        for (const row of rows) await insertJobNotification(tx, row);
        return rows.length;
      });
    },

    // Seluruh batch berjalan dalam satu transaksi: kalau gagal di tengah,
    // tabel places kembali persis seperti sebelum impor.
    async applyImport(incoming) {
      return getPrisma().$transaction(async (tx) => {
        const result: ApplyImportResult = { created: 0, updated: 0, unchanged: 0, excluded: 0, editedByAdmin: 0 };
        const exclusionRows = await tx.$queryRaw<{ osm_type: OsmType; osm_id: string }[]>`
          SELECT osm_type, osm_id::text AS osm_id FROM public.place_import_exclusions`;
        const excluded = new Set(exclusionRows.map((row) => osmKey(row.osm_type, Number(row.osm_id))));
        const candidates = incoming.filter((place) => {
          if (!excluded.has(osmKey(place.osmType, place.osmId))) return true;
          result.excluded += 1;
          return false;
        });

        for (const batch of chunk(candidates, IMPORT_BATCH_SIZE)) {
          const keys = JSON.stringify(batch.map((place) => ({ osm_type: place.osmType, osm_id: place.osmId })));
          const existingRows = await tx.$queryRaw<PlaceRow[]>`
            SELECT p.* FROM public.places AS p
            JOIN jsonb_to_recordset(${keys}::jsonb) AS k(osm_type text, osm_id bigint)
              ON p.osm_type = k.osm_type AND p.osm_id = k.osm_id`;
          const existing = new Map(existingRows.map((row) => [osmKey(row.osm_type!, Number(row.osm_id)), row]));

          const inserts: MappedPlace[] = [];
          const updates: MappedPlace[] = [];
          const unchangedIds: string[] = [];
          for (const place of batch) {
            const row = existing.get(osmKey(place.osmType, place.osmId));
            if (!row) inserts.push(place);
            else if (row.data_source !== 'osm' || row.edited_by_admin) result.editedByAdmin += 1;
            else if (hasPlaceChanged(rowComparable(row), place)) updates.push(place);
            else unchangedIds.push(row.id);
          }

          if (inserts.length) {
            const rows = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO public.places (
                osm_type, osm_id, name, category, address, latitude, longitude,
                accessibility_status, accessibility_attributes, data_source,
                source_updated_at, last_imported_at, updated_at
              )
              SELECT v.osm_type, v.osm_id, v.name, v.category, v.address, v.latitude, v.longitude,
                v.accessibility_status, v.accessibility_attributes, 'osm',
                v.source_updated_at, now(), now()
              FROM jsonb_to_recordset(${placePayload(inserts)}::jsonb) AS v(
                osm_type text, osm_id bigint, name text, category text, address text,
                latitude double precision, longitude double precision,
                accessibility_status text, accessibility_attributes jsonb, source_updated_at timestamptz
              )
              ON CONFLICT (osm_type, osm_id) WHERE osm_id IS NOT NULL DO NOTHING
              RETURNING id`;
            result.created += rows.length;
          }

          if (updates.length) {
            // Data manual dan data yang sudah diedit admin tidak pernah ditimpa impor.
            const rows = await tx.$queryRaw<{ id: string }[]>`
              UPDATE public.places AS p SET
                name = v.name,
                category = v.category,
                address = v.address,
                latitude = v.latitude,
                longitude = v.longitude,
                accessibility_status = v.accessibility_status,
                accessibility_attributes = v.accessibility_attributes,
                source_updated_at = v.source_updated_at,
                last_imported_at = now(),
                updated_at = now()
              FROM jsonb_to_recordset(${placePayload(updates)}::jsonb) AS v(
                osm_type text, osm_id bigint, name text, category text, address text,
                latitude double precision, longitude double precision,
                accessibility_status text, accessibility_attributes jsonb, source_updated_at timestamptz
              )
              WHERE p.osm_type = v.osm_type AND p.osm_id = v.osm_id
                AND p.data_source = 'osm' AND p.edited_by_admin = false
              RETURNING p.id`;
            result.updated += rows.length;
          }

          if (unchangedIds.length) {
            await tx.$executeRaw`
              UPDATE public.places SET last_imported_at = now() WHERE id = ANY(${unchangedIds}::uuid[])`;
            result.unchanged += unchangedIds.length;
          }
        }
        return result;
      }, { maxWait: 10_000, timeout: 120_000 });
    },

    async listPlaces(query) {
      const db = getPrisma();
      const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
      const status = query.status ?? null;
      const source = query.source ?? null;
      const offset = (query.page - 1) * query.pageSize;
      const rows = await db.$queryRaw<PlaceRow[]>`
        SELECT * FROM public.places
        WHERE (${pattern}::text IS NULL OR name ILIKE ${pattern}::text)
          AND (${status}::text IS NULL OR accessibility_status = ${status}::text)
          AND (${source}::text IS NULL OR data_source = ${source}::text)
        ORDER BY name ASC, id ASC
        LIMIT ${query.pageSize}::int OFFSET ${offset}::int`;
      const [count] = await db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM public.places
        WHERE (${pattern}::text IS NULL OR name ILIKE ${pattern}::text)
          AND (${status}::text IS NULL OR accessibility_status = ${status}::text)
          AND (${source}::text IS NULL OR data_source = ${source}::text)`;
      return { items: await withUsage(rows), total: count?.total ?? 0, page: query.page, pageSize: query.pageSize };
    },

    async findDuplicateCandidates(limit) {
      const db = getPrisma();
      const pairs = await db.$queryRaw<{ a_id: string; b_id: string; distance: number }[]>`
        WITH located AS (
          SELECT id, latitude, longitude,
            lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) AS normalized_name
          FROM public.places
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ), measured AS (
          SELECT a.id AS a_id, b.id AS b_id,
            sqrt(
              power((b.longitude - a.longitude) * cos(radians((a.latitude + b.latitude) / 2)) * 111320, 2)
              + power((b.latitude - a.latitude) * 110540, 2)
            ) AS distance
          FROM located AS a
          JOIN located AS b ON a.normalized_name = b.normalized_name AND a.id < b.id
          WHERE abs(a.latitude - b.latitude) < 0.0006 AND abs(a.longitude - b.longitude) < 0.0006
        )
        SELECT a_id, b_id, distance::float8 AS distance FROM measured
        WHERE distance < ${DUPLICATE_DISTANCE_METERS}::float8
        ORDER BY distance ASC, a_id
        LIMIT ${limit}::int`;
      if (!pairs.length) return [];

      const ids = [...new Set(pairs.flatMap((pair) => [pair.a_id, pair.b_id]))];
      const rows = await db.$queryRaw<PlaceRow[]>`SELECT * FROM public.places WHERE id = ANY(${ids}::uuid[])`;
      const records = new Map((await withUsage(rows)).map((place) => [place.id, place]));
      return pairs.flatMap((pair) => {
        const first = records.get(pair.a_id);
        const second = records.get(pair.b_id);
        return first && second
          ? [{ distanceMeters: Math.round(pair.distance * 10) / 10, places: [first, second] as [PlaceRecord, PlaceRecord] }]
          : [];
      });
    },

    async updatePlace(id, patch) {
      const attributes = patch.accessibilityAttributes ? JSON.stringify(cleanAttributes(patch.accessibilityAttributes)) : null;
      // Penanda edited_by_admin melindungi hasil editan dari impor ulang.
      const [row] = await getPrisma().$queryRaw<PlaceRow[]>`
        UPDATE public.places SET
          name = COALESCE(${patch.name ?? null}::text, name),
          category = COALESCE(${patch.category ?? null}::text, category),
          address = COALESCE(${patch.address ?? null}::text, address),
          latitude = COALESCE(${patch.latitude ?? null}::double precision, latitude),
          longitude = COALESCE(${patch.longitude ?? null}::double precision, longitude),
          accessibility_status = COALESCE(${patch.accessibilityStatus ?? null}::text, accessibility_status),
          accessibility_attributes = COALESCE(${attributes}::jsonb, accessibility_attributes),
          edited_by_admin = true,
          edited_at = now(),
          updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING *`;
      if (!row) return null;
      const [record] = await withUsage([row]);
      return record ?? null;
    },

    async deletePlace(id, actorId, reason) {
      const db = getPrisma();
      const contributionsPresent = await hasContributionsTable();
      return db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<PlaceRow[]>`
          SELECT * FROM public.places WHERE id = ${id}::uuid FOR UPDATE`;
        if (!row) return null;

        const [saved] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM public.saved_places WHERE place_id = ${id}::uuid`;
        let contributionCount = 0;
        if (contributionsPresent) {
          const [contributions] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM public.accessibility_contributions WHERE place_id = ${id}::uuid`;
          contributionCount = contributions?.n ?? 0;
        }

        // Exclusion dicatat dalam transaksi yang sama supaya impor berikutnya tidak memasukkannya lagi.
        const excluded = row.osm_type !== null && row.osm_id !== null;
        if (excluded) {
          await tx.$executeRaw`
            INSERT INTO public.place_import_exclusions (osm_type, osm_id, place_name, reason, excluded_by)
            VALUES (${row.osm_type}, ${String(row.osm_id)}::bigint, ${row.name}, ${reason}, ${actorId}::uuid)
            ON CONFLICT (osm_type, osm_id) DO NOTHING`;
        }
        // saved_places dan accessibility_contributions ikut terhapus lewat ON DELETE CASCADE.
        await tx.$executeRaw`DELETE FROM public.places WHERE id = ${id}::uuid`;

        return {
          id: row.id,
          name: row.name,
          dataSource: row.data_source,
          excluded,
          savedByCount: saved?.n ?? 0,
          contributionCount,
        };
      });
    },

    async listNotifications(unreadOnly) {
      const db = getPrisma();
      const rows = await db.$queryRaw<NotificationRow[]>`
        SELECT * FROM public.admin_notifications
        WHERE (${unreadOnly}::boolean = false OR is_read = false)
        ORDER BY created_at DESC, id DESC
        LIMIT 50`;
      const [count] = await db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM public.admin_notifications WHERE is_read = false`;
      return { items: rows.map(mapNotification), unreadCount: count?.total ?? 0 };
    },

    async markNotificationRead(id) {
      const [row] = await getPrisma().$queryRaw<NotificationRow[]>`
        UPDATE public.admin_notifications
        SET is_read = true, read_at = COALESCE(read_at, now())
        WHERE id = ${id}::uuid
        RETURNING *`;
      return row ? mapNotification(row) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Proses impor
// ---------------------------------------------------------------------------

class EmptyOverpassResponseError extends Error {
  override name = 'EmptyOverpassResponseError';
}

function bump(breakdown: SkipBreakdown, reason: SkipReason, amount = 1): void {
  if (amount > 0) breakdown[reason] = (breakdown[reason] ?? 0) + amount;
}

// Tidak pernah melempar error: semua kegagalan dicatat sebagai job failed.
export async function runOsmImport(store: PlaceImportStore, jobId: string, fetchOverpass: OverpassFetcher): Promise<void> {
  try {
    if (!(await store.markJobRunning(jobId))) return;

    const { elements, endpoint } = await fetchOverpass();
    if (!elements.length) throw new EmptyOverpassResponseError();

    const skipBreakdown: SkipBreakdown = {};
    const mapped = new Map<string, MappedPlace>();
    for (const raw of elements) {
      const parsed = osmElementSchema.safeParse(raw);
      if (!parsed.success) {
        bump(skipBreakdown, 'invalid_element');
        continue;
      }
      const result = mapOsmElement(parsed.data);
      if (!result.ok) {
        bump(skipBreakdown, result.reason);
        continue;
      }
      const key = osmKey(result.place.osmType, result.place.osmId);
      if (mapped.has(key)) bump(skipBreakdown, 'duplicate_in_response');
      else mapped.set(key, result.place);
    }

    const applied = await store.applyImport([...mapped.values()]);
    bump(skipBreakdown, 'excluded', applied.excluded);
    bump(skipBreakdown, 'edited_by_admin', applied.editedByAdmin);

    await store.completeJob(jobId, {
      fetchedCount: elements.length,
      createdCount: applied.created,
      updatedCount: applied.updated,
      unchangedCount: applied.unchanged,
      skippedCount: Object.values(skipBreakdown).reduce((sum, value) => sum + (value ?? 0), 0),
      skipBreakdown,
    }, endpoint);
  } catch (error) {
    const message = error instanceof OverpassUnavailableError
      ? IMPORT_MESSAGES.overpassUnavailable
      : error instanceof EmptyOverpassResponseError
        ? IMPORT_MESSAGES.emptyResponse
        : IMPORT_MESSAGES.failed;
    console.error(`Impor OSM ${jobId} gagal: ${error instanceof Error ? error.name : 'UnknownError'}`);
    try {
      await store.failJob(jobId, message);
    } catch (failError) {
      console.error(`Status job impor ${jobId} belum dapat diperbarui: ${failError instanceof Error ? failError.name : 'UnknownError'}`);
    }
  }
}

export async function failInterruptedImportJobs(store: PlaceImportStore = createPrismaPlaceImportStore()): Promise<number> {
  return store.failInterruptedJobs(IMPORT_MESSAGES.interrupted);
}
