import { z } from 'zod';

export const OSM_TYPES = ['node', 'way', 'relation'] as const;
export type OsmType = (typeof OSM_TYPES)[number];

export const ACCESSIBILITY_STATUSES = ['accessible', 'partial', 'unknown'] as const;
export type AccessibilityStatus = (typeof ACCESSIBILITY_STATUSES)[number];

export const PLACE_SOURCES = ['manual', 'osm'] as const;
export type PlaceSource = (typeof PLACE_SOURCES)[number];

// Tag OSM yang disimpan apa adanya supaya halaman detail bisa menampilkan nilai aslinya.
export const ACCESSIBILITY_ATTRIBUTE_KEYS = [
  'wheelchair',
  'toilets:wheelchair',
  'ramp',
  'ramp:wheelchair',
  'elevator',
  'tactile_paving',
  'capacity:disabled',
  'wheelchair:description',
] as const;
export type AccessibilityAttributeKey = (typeof ACCESSIBILITY_ATTRIBUTE_KEYS)[number];
export type AccessibilityAttributes = Partial<Record<AccessibilityAttributeKey, string>>;

export const PLACE_LIMITS = { name: 200, category: 80, address: 300, attribute: 500 } as const;

// Daratan DKI Jakarta termasuk pulau reklamasi. Kepulauan Seribu sengaja tidak
// diikutkan pada MVP karena berada jauh dari cakupan peta awal.
export const JAKARTA_BOUNDS = { minLat: -6.4, maxLat: -6.07, minLon: 106.65, maxLon: 107.0 } as const;

export const SKIP_REASONS = [
  'invalid_element',
  'no_name',
  'no_coordinates',
  'outside_area',
  'field_too_long',
  'no_category',
  'duplicate_in_response',
  'excluded',
  'edited_by_admin',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const coordinate = z.number().finite();

export const osmElementSchema = z.object({
  type: z.enum(OSM_TYPES),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lat: coordinate.optional(),
  lon: coordinate.optional(),
  center: z.object({ lat: coordinate, lon: coordinate }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  timestamp: z.string().optional(),
});
export type OsmElement = z.infer<typeof osmElementSchema>;

export interface MappedPlace {
  osmType: OsmType;
  osmId: number;
  name: string;
  category: string;
  address: string;
  latitude: number;
  longitude: number;
  accessibilityStatus: AccessibilityStatus;
  accessibilityAttributes: AccessibilityAttributes;
  sourceUpdatedAt: string | null;
}

export type MapResult = { ok: true; place: MappedPlace } | { ok: false; reason: SkipReason };

const AMENITY_CATEGORIES: Record<string, string> = {
  hospital: 'kesehatan',
  clinic: 'kesehatan',
  school: 'pendidikan',
  university: 'pendidikan',
  college: 'pendidikan',
  library: 'layanan publik',
  townhall: 'layanan publik',
  police: 'layanan publik',
  community_centre: 'layanan publik',
  bank: 'keuangan',
  bus_station: 'transportasi',
  marketplace: 'perbelanjaan',
};

// Urutan pengecekan menentukan kategori kalau satu elemen punya beberapa tag yang cocok.
export function categoryFor(tags: Record<string, string>): string | null {
  const amenity = tags.amenity ? AMENITY_CATEGORIES[tags.amenity] : undefined;
  if (amenity) return amenity;
  if (tags.railway === 'station' || tags.public_transport === 'station') return 'transportasi';
  if (tags.shop === 'mall') return 'perbelanjaan';
  if (tags.leisure === 'park') return 'taman';
  if (tags.tourism === 'museum' || tags.tourism === 'attraction') return 'wisata dan budaya';
  return null;
}

function clean(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

export function buildAddress(tags: Record<string, string>): string {
  const full = clean(tags['addr:full']);
  if (full) return full;

  const street = [clean(tags['addr:street']), clean(tags['addr:housenumber'])].filter(Boolean).join(' ');
  const area = clean(tags['addr:suburb']) || clean(tags['addr:subdistrict']);
  return [street, area, clean(tags['addr:city'])].filter(Boolean).join(', ');
}

export function extractAccessibilityAttributes(tags: Record<string, string>): AccessibilityAttributes {
  const attributes: AccessibilityAttributes = {};
  for (const key of ACCESSIBILITY_ATTRIBUTE_KEYS) {
    const value = clean(tags[key]);
    if (value) attributes[key] = value.slice(0, PLACE_LIMITS.attribute);
  }
  return attributes;
}

// wheelchair=no tetap menjadi unknown karena belum ada status "tidak aksesibel".
// Nilai aslinya tetap tersimpan di atribut sehingga tidak hilang.
export function deriveAccessibilityStatus(attributes: AccessibilityAttributes): AccessibilityStatus {
  const wheelchair = attributes.wheelchair?.toLowerCase();
  if (wheelchair === 'yes' || wheelchair === 'designated') return 'accessible';
  if (wheelchair === 'limited') return 'partial';
  return 'unknown';
}

export function isInsideJakarta(latitude: number, longitude: number): boolean {
  return latitude >= JAKARTA_BOUNDS.minLat && latitude <= JAKARTA_BOUNDS.maxLat
    && longitude >= JAKARTA_BOUNDS.minLon && longitude <= JAKARTA_BOUNDS.maxLon;
}

function toIsoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function mapOsmElement(element: OsmElement): MapResult {
  const tags = element.tags ?? {};
  const name = clean(tags.name);
  if (!name) return { ok: false, reason: 'no_name' };

  const point = element.type === 'node' && element.lat !== undefined && element.lon !== undefined
    ? { lat: element.lat, lon: element.lon }
    : element.center;
  if (!point) return { ok: false, reason: 'no_coordinates' };
  if (!isInsideJakarta(point.lat, point.lon)) return { ok: false, reason: 'outside_area' };

  const category = categoryFor(tags);
  if (!category) return { ok: false, reason: 'no_category' };

  const address = buildAddress(tags);
  if (name.length > PLACE_LIMITS.name || address.length > PLACE_LIMITS.address) {
    return { ok: false, reason: 'field_too_long' };
  }

  const accessibilityAttributes = extractAccessibilityAttributes(tags);
  return {
    ok: true,
    place: {
      osmType: element.type,
      osmId: element.id,
      name,
      category,
      address,
      latitude: point.lat,
      longitude: point.lon,
      accessibilityStatus: deriveAccessibilityStatus(accessibilityAttributes),
      accessibilityAttributes,
      sourceUpdatedAt: toIsoOrNull(element.timestamp),
    },
  };
}

export function osmKey(osmType: OsmType, osmId: number): string {
  return `${osmType}/${osmId}`;
}

function stableAttributes(attributes: AccessibilityAttributes): string {
  return JSON.stringify(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
}

function sameTime(a: string | null, b: string | null): boolean {
  return (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
}

type ComparablePlace = Omit<MappedPlace, 'osmType' | 'osmId'>;

// Dipakai untuk memutuskan "updated" atau "unchanged", jadi impor ulang tidak menimpa tanpa perlu.
export function hasPlaceChanged(existing: ComparablePlace, incoming: ComparablePlace): boolean {
  return existing.name !== incoming.name
    || existing.category !== incoming.category
    || existing.address !== incoming.address
    || Math.abs(existing.latitude - incoming.latitude) > 1e-7
    || Math.abs(existing.longitude - incoming.longitude) > 1e-7
    || existing.accessibilityStatus !== incoming.accessibilityStatus
    || stableAttributes(existing.accessibilityAttributes) !== stableAttributes(incoming.accessibilityAttributes)
    || !sameTime(existing.sourceUpdatedAt, incoming.sourceUpdatedAt);
}

export function normalizePlaceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Perkiraan equirectangular. Cukup akurat untuk jarak puluhan meter tanpa PostGIS.
export function approximateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lon2 - lon1) * Math.cos(meanLat) * 111_320;
  const dy = (lat2 - lat1) * 110_540;
  return Math.sqrt(dx * dx + dy * dy);
}
