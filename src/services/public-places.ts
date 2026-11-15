import { z } from 'zod';
import { getPrisma } from '../lib/prisma.js';
import {
  ACCESSIBILITY_STATUSES,
  type AccessibilityAttributes,
  type AccessibilityStatus,
  type OsmType,
  type PlaceSource,
} from './osm-mapping.js';

export const MAX_PLACES_PER_REQUEST = 500;

const bboxMessage = 'bbox harus berformat minLon,minLat,maxLon,maxLat.';

// bbox mengikuti urutan GeoJSON: bujur dulu, lalu lintang.
const bboxSchema = z.string().trim()
  .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, bboxMessage)
  .transform((value) => value.split(',').map(Number) as [number, number, number, number])
  .refine(([minLon, minLat, maxLon, maxLat]) => minLon < maxLon && minLat < maxLat
    && minLon >= -180 && maxLon <= 180 && minLat >= -90 && maxLat <= 90, { message: bboxMessage });

export const publicPlacesQuerySchema = z.strictObject({
  bbox: bboxSchema,
  status: z.enum(ACCESSIBILITY_STATUSES, { message: 'Status aksesibilitas tidak dikenal.' }).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PLACES_PER_REQUEST, `Maksimal ${MAX_PLACES_PER_REQUEST} tempat per permintaan.`)
    .default(300),
});
export type PublicPlacesQuery = z.infer<typeof publicPlacesQuerySchema>;

export const publicPlacesSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1, 'Kata kunci pencarian tidak boleh kosong.').max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PublicPlacesSearchQuery = z.infer<typeof publicPlacesSearchQuerySchema>;

// Hanya data yang aman untuk publik. Jumlah pengguna yang menyimpan tempat tidak disertakan.
export interface PublicPlace {
  id: string;
  name: string;
  category: string;
  address: string;
  latitude: number;
  longitude: number;
  accessibilityStatus: AccessibilityStatus;
  accessibilityAttributes: AccessibilityAttributes;
  dataSource: PlaceSource;
  osmType: OsmType | null;
  osmId: number | null;
  sourceUpdatedAt: string | null;
  updatedAt: string;
}

export interface PublicPlacesResult {
  items: PublicPlace[];
  truncated: boolean;
}

export interface PublicPlacesReader {
  listInBounds(query: PublicPlacesQuery): Promise<PublicPlacesResult>;
  search(query: PublicPlacesSearchQuery): Promise<PublicPlace[]>;
}

const statusRank: Record<AccessibilityStatus, number> = { accessible: 0, partial: 1, unknown: 2 };

// Tempat yang sudah punya informasi aksesibilitas didahulukan saat hasil dipotong.
function comparePlaces(a: PublicPlace, b: PublicPlace): number {
  return statusRank[a.accessibilityStatus] - statusRank[b.accessibilityStatus]
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

export function createInMemoryPublicPlacesReader(places: PublicPlace[]): PublicPlacesReader {
  return {
    async listInBounds({ bbox: [minLon, minLat, maxLon, maxLat], status, limit }) {
      const matches = places
        .filter((place) => place.latitude >= minLat && place.latitude <= maxLat
          && place.longitude >= minLon && place.longitude <= maxLon)
        .filter((place) => !status || place.accessibilityStatus === status)
        .sort(comparePlaces);
      return { items: matches.slice(0, limit), truncated: matches.length > limit };
    },
    async search({ q, limit }) {
      const lower = q.toLowerCase();
      const matches = places.filter((p) =>
        p.name.toLowerCase().includes(lower) ||
        p.address.toLowerCase().includes(lower) ||
        p.category.toLowerCase().includes(lower)
      );
      matches.sort((a, b) => {
        const aName = a.name.toLowerCase();
        const bName = b.name.toLowerCase();
        const aScore = aName === lower ? 0 : aName.startsWith(lower) ? 1 : 2;
        const bScore = bName === lower ? 0 : bName.startsWith(lower) ? 1 : 2;
        return aScore - bScore || comparePlaces(a, b);
      });
      return matches.slice(0, limit);
    },
  };
}

type PublicPlaceRow = {
  id: string;
  name: string;
  category: string;
  address: string;
  latitude: number;
  longitude: number;
  accessibility_status: AccessibilityStatus;
  accessibility_attributes: AccessibilityAttributes | null;
  data_source: PlaceSource;
  osm_type: OsmType | null;
  osm_id: string | null;
  source_updated_at: Date | null;
  updated_at: Date;
};

export function createPrismaPublicPlacesReader(): PublicPlacesReader {
  return {
    async listInBounds({ bbox: [minLon, minLat, maxLon, maxLat], status, limit }) {
      // Satu baris tambahan dipakai untuk mengetahui apakah hasil terpotong.
      const rows = await getPrisma().$queryRaw<PublicPlaceRow[]>`
        SELECT id, name, category, address, latitude, longitude,
          accessibility_status, accessibility_attributes, data_source,
          osm_type, osm_id::text AS osm_id, source_updated_at, updated_at
        FROM public.places
        WHERE latitude BETWEEN ${minLat}::float8 AND ${maxLat}::float8
          AND longitude BETWEEN ${minLon}::float8 AND ${maxLon}::float8
          AND (${status ?? null}::text IS NULL OR accessibility_status = ${status ?? null}::text)
        ORDER BY CASE accessibility_status WHEN 'accessible' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
          name ASC, id ASC
        LIMIT ${limit + 1}::int`;
      return {
        items: rows.slice(0, limit).map((row) => ({
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
          sourceUpdatedAt: row.source_updated_at ? row.source_updated_at.toISOString() : null,
          updatedAt: row.updated_at.toISOString(),
        })),
        truncated: rows.length > limit,
      };
    },
    async search({ q, limit }) {
      const searchTerm = `%${q}%`;
      const exactTerm = q;
      const prefixTerm = `${q}%`;

      const rows = await getPrisma().$queryRaw<PublicPlaceRow[]>`
        SELECT id, name, category, address, latitude, longitude,
          accessibility_status, accessibility_attributes, data_source,
          osm_type, osm_id::text AS osm_id, source_updated_at, updated_at
        FROM public.places
        WHERE (
          name ILIKE ${searchTerm}
          OR address ILIKE ${searchTerm}
          OR category ILIKE ${searchTerm}
        )
        ORDER BY
          CASE
            WHEN name ILIKE ${exactTerm} THEN 0
            WHEN name ILIKE ${prefixTerm} THEN 1
            WHEN name ILIKE ${searchTerm} THEN 2
            ELSE 3
          END,
          CASE accessibility_status WHEN 'accessible' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
          name ASC, id ASC
        LIMIT ${limit}::int`;

      return rows.map((row) => ({
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
        sourceUpdatedAt: row.source_updated_at ? row.source_updated_at.toISOString() : null,
        updatedAt: row.updated_at.toISOString(),
      }));
    },
  };
}
