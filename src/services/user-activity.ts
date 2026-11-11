import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';

export const ACTIVITY_TYPES = ['comment', 'contribution'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CONTRIBUTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

export const CONTRIBUTION_STATUS_LABELS: Record<ContributionStatus, string> = {
  pending: 'Menunggu peninjauan',
  approved: 'Disetujui',
  rejected: 'Belum disetujui',
};

// Activity Models
export interface BaseActivityRecord {
  id: string;
  userId: string;
  type: ActivityType;
  createdAt: string;
}

export interface CommentActivityRecord extends BaseActivityRecord {
  type: 'comment';
  postId: string;
  postTitle: string;
  content: string;
}

export interface ContributionActivityRecord extends BaseActivityRecord {
  type: 'contribution';
  placeId: string;
  placeName: string;
  placeAddress: string;
  placeCategory: string;
  status: ContributionStatus;
  statusLabel: string;
  notes: string;
  rejectionReason: string | null;
}

export type UserActivityRecord = CommentActivityRecord | ContributionActivityRecord;

export interface ActivitySummary {
  totalActivities: number;
  totalComments: number;
  totalContributions: number;
}

export interface SavedPlaceRecord {
  id: string;
  userId: string;
  placeId: string;
  placeName: string;
  placeAddress: string;
  placeCategory: string;
  createdAt: string;
}

export interface ProfileSummary extends ActivitySummary {
  totalSavedPlaces: number;
}

export class ActivityDomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ActivityDomainError';
    this.status = status;
    this.code = code;
  }
}

// Schemas for validation
export const createCommentSchema = z.strictObject({
  postId: z.string().uuid({ message: 'ID postingan tidak valid.' }),
  content: z
    .string()
    .trim()
    .min(1, 'Isi komentar tidak boleh kosong.')
    .max(1000, 'Isi komentar maksimal 1000 karakter.'),
});

export const createContributionSchema = z.strictObject({
  placeId: z.string().uuid({ message: 'ID lokasi tidak valid.' }),
  notes: z
    .string()
    .trim()
    .min(3, 'Deskripsi kontribusi minimal 3 karakter.')
    .max(1000, 'Deskripsi kontribusi maksimal 1000 karakter.'),
  status: z.enum(CONTRIBUTION_STATUSES).default('pending'),
  rejectionReason: z.string().trim().max(500).optional().nullable(),
});

export const activityQuerySchema = z.object({
  type: z.enum(['all', 'comment', 'contribution']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ActivityQueryOptions = z.infer<typeof activityQuerySchema>;

export interface UserActivityStore {
  listByUser(userId: string, options?: Partial<ActivityQueryOptions>): Promise<{
    items: UserActivityRecord[];
    total: number;
    summary: ActivitySummary;
  }>;
  createComment(userId: string, input: z.infer<typeof createCommentSchema>): Promise<CommentActivityRecord>;
  createContribution(userId: string, input: z.infer<typeof createContributionSchema>): Promise<ContributionActivityRecord>;
  getSummary(userId: string): Promise<ActivitySummary>;
  listSavedPlaces(userId: string): Promise<SavedPlaceRecord[]>;
  addSavedPlace(userId: string, placeId: string): Promise<SavedPlaceRecord>;
  removeSavedPlace(userId: string, savedId: string): Promise<boolean>;
  getProfileSummary(userId: string): Promise<ProfileSummary>;
}

/**
 * In-memory store implementation for testing and fallback
 */
export function createInMemoryActivityStore(initialData?: {
  comments?: Array<Omit<CommentActivityRecord, 'type'>>;
  contributions?: Array<Omit<ContributionActivityRecord, 'type' | 'statusLabel'>>;
  savedPlaces?: SavedPlaceRecord[];
}): UserActivityStore {
  const comments = new Map<string, CommentActivityRecord>();
  const contributions = new Map<string, ContributionActivityRecord>();
  const savedPlaces = new Map<string, SavedPlaceRecord>();

  if (initialData?.comments) {
    for (const c of initialData.comments) {
      comments.set(c.id, { ...c, type: 'comment' });
    }
  }

  if (initialData?.contributions) {
    for (const c of initialData.contributions) {
      contributions.set(c.id, {
        ...c,
        type: 'contribution',
        statusLabel: CONTRIBUTION_STATUS_LABELS[c.status],
      });
    }
  }

  if (initialData?.savedPlaces) {
    for (const s of initialData.savedPlaces) {
      savedPlaces.set(s.id, s);
    }
  }

  return {
    async listByUser(userId: string, options?: Partial<ActivityQueryOptions>) {
      const type = options?.type ?? 'all';
      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;

      const userComments = Array.from(comments.values()).filter((c) => c.userId === userId);
      const userContributions = Array.from(contributions.values()).filter((c) => c.userId === userId);

      let merged: UserActivityRecord[] = [];
      if (type === 'all' || type === 'comment') {
        merged.push(...userComments);
      }
      if (type === 'all' || type === 'contribution') {
        merged.push(...userContributions);
      }

      // Sort chronological descending
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const total = merged.length;
      const paged = merged.slice(offset, offset + limit);

      const summary: ActivitySummary = {
        totalActivities: userComments.length + userContributions.length,
        totalComments: userComments.length,
        totalContributions: userContributions.length,
      };

      return {
        items: paged,
        total,
        summary,
      };
    },

    async createComment(userId: string, input: z.infer<typeof createCommentSchema>) {
      const now = new Date().toISOString();
      const id = randomUUID();
      const record: CommentActivityRecord = {
        id,
        userId,
        type: 'comment',
        postId: input.postId,
        postTitle: 'Diskusi Komunitas',
        content: input.content,
        createdAt: now,
      };
      comments.set(id, record);
      return record;
    },

    async createContribution(userId: string, input: z.infer<typeof createContributionSchema>) {
      const now = new Date().toISOString();
      const id = randomUUID();
      const status = input.status ?? 'pending';
      const record: ContributionActivityRecord = {
        id,
        userId,
        type: 'contribution',
        placeId: input.placeId,
        placeName: 'Lokasi Fasilitas Publik',
        placeAddress: 'Jl. Contoh Alamat No. 123',
        placeCategory: 'Fasilitas Umum',
        status,
        statusLabel: CONTRIBUTION_STATUS_LABELS[status],
        notes: input.notes,
        rejectionReason: input.rejectionReason ?? null,
        createdAt: now,
      };
      contributions.set(id, record);
      return record;
    },

    async getSummary(userId: string) {
      const userComments = Array.from(comments.values()).filter((c) => c.userId === userId);
      const userContributions = Array.from(contributions.values()).filter((c) => c.userId === userId);
      return {
        totalActivities: userComments.length + userContributions.length,
        totalComments: userComments.length,
        totalContributions: userContributions.length,
      };
    },

    async listSavedPlaces(userId: string) {
      return Array.from(savedPlaces.values())
        .filter((s) => s.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async addSavedPlace(userId: string, placeId: string) {
      const existing = Array.from(savedPlaces.values()).find((s) => s.userId === userId && s.placeId === placeId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const id = randomUUID();
      const record: SavedPlaceRecord = {
        id,
        userId,
        placeId,
        placeName: 'Lokasi Fasilitas Tersimpan',
        placeAddress: 'Jl. Contoh Alamat No. 123',
        placeCategory: 'Fasilitas Umum',
        createdAt: now,
      };
      savedPlaces.set(id, record);
      return record;
    },

    async removeSavedPlace(userId: string, savedId: string) {
      const place = savedPlaces.get(savedId);
      if (!place || place.userId !== userId) return false;
      return savedPlaces.delete(savedId);
    },

    async getProfileSummary(userId: string) {
      const userComments = Array.from(comments.values()).filter((c) => c.userId === userId);
      const userContributions = Array.from(contributions.values()).filter((c) => c.userId === userId);
      const userSaved = Array.from(savedPlaces.values()).filter((s) => s.userId === userId);
      return {
        totalActivities: userComments.length + userContributions.length,
        totalComments: userComments.length,
        totalContributions: userContributions.length,
        totalSavedPlaces: userSaved.length,
      };
    },
  };
}

let activityTablesPromise: Promise<void> | null = null;

export async function ensureActivityTablesExist(): Promise<void> {
  if (activityTablesPromise) return activityTablesPromise;

  activityTablesPromise = (async () => {
    const db = getPrisma();
    const statements = [
      // Places table if not exists (minimal structure aligned with PRD)
      `create table if not exists public.places (
        id uuid primary key default gen_random_uuid(),
        osm_id text,
        name text not null,
        category text not null default 'Umum',
        address text not null default '',
        latitude double precision default -6.2088,
        longitude double precision default 106.8456,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists places_name_idx on public.places (name)`,

      // Community posts table if not exists
      `create table if not exists public.community_posts (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        place_id uuid references public.places(id) on delete set null,
        title text not null,
        content text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists community_posts_user_idx on public.community_posts (user_id, created_at desc)`,

      // Community comments table
      `create table if not exists public.community_comments (
        id uuid primary key default gen_random_uuid(),
        post_id uuid not null references public.community_posts(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        content text not null check (char_length(content) between 1 and 1000),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists community_comments_user_idx on public.community_comments (user_id, created_at desc)`,
      `create index if not exists community_comments_post_idx on public.community_comments (post_id, created_at asc)`,

      // Accessibility contributions (review/laporan fasilitas aksesibilitas lokasi)
      `create table if not exists public.accessibility_contributions (
        id uuid primary key default gen_random_uuid(),
        place_id uuid not null references public.places(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade,
        status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
        notes text not null check (char_length(notes) between 3 and 1000),
        rejection_reason text default null check (rejection_reason is null or char_length(rejection_reason) <= 500),
        submitted_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index if not exists accessibility_contributions_user_idx on public.accessibility_contributions (user_id, submitted_at desc)`,
      `create index if not exists accessibility_contributions_place_idx on public.accessibility_contributions (place_id)`,

      // Saved places table
      `create table if not exists public.saved_places (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        place_id uuid not null references public.places(id) on delete cascade,
        created_at timestamptz not null default now(),
        unique(user_id, place_id)
      )`,
      `create index if not exists saved_places_user_idx on public.saved_places (user_id, created_at desc)`,

      // RLS policies
      `alter table public.community_comments enable row level security`,
      `alter table public.accessibility_contributions enable row level security`,
      `alter table public.saved_places enable row level security`,
      `grant select, insert on public.community_comments to authenticated`,
      `grant select, insert on public.accessibility_contributions to authenticated`,
      `grant select, insert, delete on public.saved_places to authenticated`,

      `drop policy if exists "Users can read own comments" on public.community_comments`,
      `create policy "Users can read own comments" on public.community_comments for select to authenticated using ((select auth.uid()) = user_id)`,

      `drop policy if exists "Users can read own contributions" on public.accessibility_contributions`,
      `create policy "Users can read own contributions" on public.accessibility_contributions for select to authenticated using ((select auth.uid()) = user_id)`,

      `drop policy if exists "Users can manage own saved places" on public.saved_places`,
      `create policy "Users can manage own saved places" on public.saved_places for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)`,
    ];

    for (const sql of statements) {
      await db.$executeRawUnsafe(sql);
    }
  })().catch((err) => {
    activityTablesPromise = null;
    throw err;
  });

  return activityTablesPromise;
}

/**
 * Prisma/PostgreSQL implementation
 */
export function createPrismaActivityStore(): UserActivityStore {
  type RawCommentRow = {
    id: string;
    user_id: string;
    post_id: string;
    post_title: string | null;
    content: string;
    created_at: Date;
  };

  type RawContributionRow = {
    id: string;
    user_id: string;
    place_id: string;
    place_name: string | null;
    place_address: string | null;
    place_category: string | null;
    status: ContributionStatus;
    notes: string;
    rejection_reason: string | null;
    created_at: Date;
  };

  return {
    async listByUser(userId: string, options?: Partial<ActivityQueryOptions>) {
      await ensureActivityTablesExist();
      const db = getPrisma();
      const type = options?.type ?? 'all';
      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;

      let comments: CommentActivityRecord[] = [];
      let contributions: ContributionActivityRecord[] = [];

      if (type === 'all' || type === 'comment') {
        const commentRows = await db.$queryRaw<RawCommentRow[]>`
          SELECT 
            c.id,
            c.user_id,
            c.post_id,
            COALESCE(p.title, 'Postingan Komunitas') AS post_title,
            c.content,
            c.created_at
          FROM public.community_comments c
          LEFT JOIN public.community_posts p ON p.id = c.post_id
          WHERE c.user_id = ${userId}::uuid
          ORDER BY c.created_at DESC
          LIMIT 100`;

        comments = commentRows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          type: 'comment',
          postId: r.post_id,
          postTitle: r.post_title ?? 'Postingan Komunitas',
          content: r.content,
          createdAt: r.created_at.toISOString(),
        }));
      }

      if (type === 'all' || type === 'contribution') {
        const contributionRows = await db.$queryRaw<RawContributionRow[]>`
          SELECT 
            a.id,
            a.user_id,
            a.place_id,
            COALESCE(pl.name, 'Lokasi Fasilitas Publik') AS place_name,
            COALESCE(pl.address, '') AS place_address,
            COALESCE(pl.category, 'Umum') AS place_category,
            a.status,
            a.notes,
            a.rejection_reason,
            a.submitted_at AS created_at
          FROM public.accessibility_contributions a
          LEFT JOIN public.places pl ON pl.id = a.place_id
          WHERE a.user_id = ${userId}::uuid
          ORDER BY a.submitted_at DESC
          LIMIT 100`;

        contributions = contributionRows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          type: 'contribution',
          placeId: r.place_id,
          placeName: r.place_name ?? 'Lokasi Fasilitas Publik',
          placeAddress: r.place_address ?? '',
          placeCategory: r.place_category ?? 'Umum',
          status: r.status,
          statusLabel: CONTRIBUTION_STATUS_LABELS[r.status] ?? r.status,
          notes: r.notes,
          rejectionReason: r.rejection_reason,
          createdAt: r.created_at.toISOString(),
        }));
      }

      // Summary counts
      const [commentCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.community_comments WHERE user_id = ${userId}::uuid`;
      const [contributionCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.accessibility_contributions WHERE user_id = ${userId}::uuid`;

      const totalComments = Number(commentCountResult?.count ?? 0);
      const totalContributions = Number(contributionCountResult?.count ?? 0);

      const merged: UserActivityRecord[] = [...comments, ...contributions];
      merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const total = type === 'comment' ? totalComments : type === 'contribution' ? totalContributions : totalComments + totalContributions;
      const paged = merged.slice(offset, offset + limit);

      return {
        items: paged,
        total,
        summary: {
          totalActivities: totalComments + totalContributions,
          totalComments,
          totalContributions,
        },
      };
    },

    async createComment(userId: string, input: z.infer<typeof createCommentSchema>) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      const [row] = await db.$queryRaw<RawCommentRow[]>`
        WITH inserted AS (
          INSERT INTO public.community_comments (user_id, post_id, content)
          VALUES (${userId}::uuid, ${input.postId}::uuid, ${input.content})
          RETURNING *
        )
        SELECT 
          i.id,
          i.user_id,
          i.post_id,
          COALESCE(p.title, 'Postingan Komunitas') AS post_title,
          i.content,
          i.created_at
        FROM inserted i
        LEFT JOIN public.community_posts p ON p.id = i.post_id`;

      if (!row) {
        throw new ActivityDomainError(500, 'CREATE_COMMENT_FAILED', 'Gagal menyimpan komentar.');
      }

      return {
        id: row.id,
        userId: row.user_id,
        type: 'comment',
        postId: row.post_id,
        postTitle: row.post_title ?? 'Postingan Komunitas',
        content: row.content,
        createdAt: row.created_at.toISOString(),
      };
    },

    async createContribution(userId: string, input: z.infer<typeof createContributionSchema>) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      const status = input.status ?? 'pending';
      const [row] = await db.$queryRaw<RawContributionRow[]>`
        WITH inserted AS (
          INSERT INTO public.accessibility_contributions (user_id, place_id, notes, status, rejection_reason)
          VALUES (
            ${userId}::uuid, 
            ${input.placeId}::uuid, 
            ${input.notes}, 
            ${status}, 
            ${input.rejectionReason ?? null}
          )
          RETURNING *
        )
        SELECT 
          i.id,
          i.user_id,
          i.place_id,
          COALESCE(pl.name, 'Lokasi Fasilitas Publik') AS place_name,
          COALESCE(pl.address, '') AS place_address,
          COALESCE(pl.category, 'Umum') AS place_category,
          i.status,
          i.notes,
          i.rejection_reason,
          i.submitted_at AS created_at
        FROM inserted i
        LEFT JOIN public.places pl ON pl.id = i.place_id`;

      if (!row) {
        throw new ActivityDomainError(500, 'CREATE_CONTRIBUTION_FAILED', 'Gagal menyimpan kontribusi lokasi.');
      }

      return {
        id: row.id,
        userId: row.user_id,
        type: 'contribution',
        placeId: row.place_id,
        placeName: row.place_name ?? 'Lokasi Fasilitas Publik',
        placeAddress: row.place_address ?? '',
        placeCategory: row.place_category ?? 'Umum',
        status: row.status,
        statusLabel: CONTRIBUTION_STATUS_LABELS[row.status] ?? row.status,
        notes: row.notes,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at.toISOString(),
      };
    },

    async getSummary(userId: string) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      const [commentCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.community_comments WHERE user_id = ${userId}::uuid`;
      const [contributionCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.accessibility_contributions WHERE user_id = ${userId}::uuid`;

      const totalComments = Number(commentCountResult?.count ?? 0);
      const totalContributions = Number(contributionCountResult?.count ?? 0);

      return {
        totalActivities: totalComments + totalContributions,
        totalComments,
        totalContributions,
      };
    },

    async listSavedPlaces(userId: string) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      type RawSavedRow = {
        id: string;
        user_id: string;
        place_id: string;
        place_name: string | null;
        place_address: string | null;
        place_category: string | null;
        created_at: Date;
      };

      const rows = await db.$queryRaw<RawSavedRow[]>`
        SELECT 
          s.id,
          s.user_id,
          s.place_id,
          COALESCE(pl.name, 'Lokasi Fasilitas Publik') AS place_name,
          COALESCE(pl.address, '') AS place_address,
          COALESCE(pl.category, 'Umum') AS place_category,
          s.created_at
        FROM public.saved_places s
        LEFT JOIN public.places pl ON pl.id = s.place_id
        WHERE s.user_id = ${userId}::uuid
        ORDER BY s.created_at DESC`;

      return rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        placeId: r.place_id,
        placeName: r.place_name ?? 'Lokasi Fasilitas Publik',
        placeAddress: r.place_address ?? '',
        placeCategory: r.place_category ?? 'Umum',
        createdAt: r.created_at.toISOString(),
      }));
    },

    async addSavedPlace(userId: string, placeId: string) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      type RawSavedRow = {
        id: string;
        user_id: string;
        place_id: string;
        place_name: string | null;
        place_address: string | null;
        place_category: string | null;
        created_at: Date;
      };

      const [row] = await db.$queryRaw<RawSavedRow[]>`
        WITH upserted AS (
          INSERT INTO public.saved_places (user_id, place_id)
          VALUES (${userId}::uuid, ${placeId}::uuid)
          ON CONFLICT (user_id, place_id) DO UPDATE SET created_at = public.saved_places.created_at
          RETURNING *
        )
        SELECT 
          u.id,
          u.user_id,
          u.place_id,
          COALESCE(pl.name, 'Lokasi Fasilitas Publik') AS place_name,
          COALESCE(pl.address, '') AS place_address,
          COALESCE(pl.category, 'Umum') AS place_category,
          u.created_at
        FROM upserted u
        LEFT JOIN public.places pl ON pl.id = u.place_id`;

      if (!row) {
        throw new ActivityDomainError(500, 'SAVE_PLACE_FAILED', 'Gagal menyimpan lokasi.');
      }

      return {
        id: row.id,
        userId: row.user_id,
        placeId: row.place_id,
        placeName: row.place_name ?? 'Lokasi Fasilitas Publik',
        placeAddress: row.place_address ?? '',
        placeCategory: row.place_category ?? 'Umum',
        createdAt: row.created_at.toISOString(),
      };
    },

    async removeSavedPlace(userId: string, savedId: string) {
      await ensureActivityTablesExist();
      const db = getPrisma();
      const count = await db.$executeRaw`
        DELETE FROM public.saved_places WHERE id = ${savedId}::uuid AND user_id = ${userId}::uuid`;
      return count > 0;
    },

    async getProfileSummary(userId: string) {
      await ensureActivityTablesExist();
      const db = getPrisma();

      const [commentCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.community_comments WHERE user_id = ${userId}::uuid`;
      const [contributionCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.accessibility_contributions WHERE user_id = ${userId}::uuid`;
      const [savedCountResult] = await db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM public.saved_places WHERE user_id = ${userId}::uuid`;

      const totalComments = Number(commentCountResult?.count ?? 0);
      const totalContributions = Number(contributionCountResult?.count ?? 0);
      const totalSavedPlaces = Number(savedCountResult?.count ?? 0);

      return {
        totalActivities: totalComments + totalContributions,
        totalComments,
        totalContributions,
        totalSavedPlaces,
      };
    },
  };
}

