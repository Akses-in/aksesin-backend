import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approximateDistanceMeters,
  buildAddress,
  categoryFor,
  deriveAccessibilityStatus,
  hasPlaceChanged,
  mapOsmElement,
  normalizePlaceName,
  type MappedPlace,
} from '../src/services/osm-mapping.js';
import { buildOverpassQuery } from '../src/services/overpass.js';

test('PBI-09: node dipetakan ke kategori, alamat, koordinat, atribut, dan status', () => {
  const result = mapOsmElement({
    type: 'node',
    id: 1001,
    lat: -6.1965,
    lon: 106.8463,
    timestamp: '2026-10-01T08:00:00Z',
    tags: {
      amenity: 'hospital',
      name: '  RSUPN   Dr. Cipto Mangunkusumo ',
      'addr:street': 'Jalan Diponegoro',
      'addr:housenumber': '71',
      'addr:suburb': 'Kenari',
      'addr:city': 'Jakarta Pusat',
      wheelchair: 'yes',
      'toilets:wheelchair': 'yes',
      tactile_paving: 'no',
      opening_hours: '24/7',
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(result.place, {
    osmType: 'node',
    osmId: 1001,
    name: 'RSUPN Dr. Cipto Mangunkusumo',
    category: 'kesehatan',
    address: 'Jalan Diponegoro 71, Kenari, Jakarta Pusat',
    latitude: -6.1965,
    longitude: 106.8463,
    accessibilityStatus: 'accessible',
    accessibilityAttributes: { wheelchair: 'yes', 'toilets:wheelchair': 'yes', tactile_paving: 'no' },
    sourceUpdatedAt: '2026-10-01T08:00:00.000Z',
  });
});

test('PBI-09: way memakai titik tengah dan addr:full lebih diutamakan', () => {
  const result = mapOsmElement({
    type: 'way',
    id: 2002,
    center: { lat: -6.3634, lon: 106.8269 },
    tags: {
      amenity: 'university',
      name: 'Universitas Indonesia',
      'addr:full': 'Jalan Margonda Raya, Jakarta',
      'addr:street': 'tidak dipakai',
      wheelchair: 'limited',
      ramp: 'yes',
    },
  });

  assert.ok(result.ok);
  assert.equal(result.place.latitude, -6.3634);
  assert.equal(result.place.longitude, 106.8269);
  assert.equal(result.place.category, 'pendidikan');
  assert.equal(result.place.address, 'Jalan Margonda Raya, Jakarta');
  assert.equal(result.place.accessibilityStatus, 'partial');
  assert.equal(result.place.sourceUpdatedAt, null);
});

test('PBI-09: status mengikuti tag wheelchair dan nilai asli tetap tersimpan', () => {
  assert.equal(deriveAccessibilityStatus({ wheelchair: 'yes' }), 'accessible');
  assert.equal(deriveAccessibilityStatus({ wheelchair: 'designated' }), 'accessible');
  assert.equal(deriveAccessibilityStatus({ wheelchair: 'limited' }), 'partial');
  assert.equal(deriveAccessibilityStatus({ wheelchair: 'no' }), 'unknown');
  assert.equal(deriveAccessibilityStatus({}), 'unknown');

  const result = mapOsmElement({
    type: 'node', id: 3, lat: -6.2, lon: 106.8, tags: { leisure: 'park', name: 'Taman Suropati', wheelchair: 'no' },
  });
  assert.ok(result.ok);
  assert.equal(result.place.accessibilityStatus, 'unknown');
  assert.equal(result.place.accessibilityAttributes.wheelchair, 'no');
});

test('PBI-09: kategori memakai label Indonesia yang konsisten', () => {
  assert.equal(categoryFor({ amenity: 'clinic' }), 'kesehatan');
  assert.equal(categoryFor({ amenity: 'library' }), 'layanan publik');
  assert.equal(categoryFor({ amenity: 'police' }), 'layanan publik');
  assert.equal(categoryFor({ amenity: 'bank' }), 'keuangan');
  assert.equal(categoryFor({ amenity: 'bus_station' }), 'transportasi');
  assert.equal(categoryFor({ railway: 'station' }), 'transportasi');
  assert.equal(categoryFor({ public_transport: 'station' }), 'transportasi');
  assert.equal(categoryFor({ shop: 'mall' }), 'perbelanjaan');
  assert.equal(categoryFor({ amenity: 'marketplace' }), 'perbelanjaan');
  assert.equal(categoryFor({ leisure: 'park' }), 'taman');
  assert.equal(categoryFor({ tourism: 'museum' }), 'wisata dan budaya');
  assert.equal(categoryFor({ shop: 'convenience' }), null);
  assert.equal(buildAddress({}), '');
});

test('PBI-09: elemen tidak valid ditolak dengan alasan yang jelas', () => {
  const base = { type: 'node' as const, id: 9, lat: -6.2, lon: 106.8 };
  assert.deepEqual(mapOsmElement({ ...base, tags: { amenity: 'bank' } }), { ok: false, reason: 'no_name' });
  assert.deepEqual(mapOsmElement({ ...base, tags: { amenity: 'bank', name: '   ' } }), { ok: false, reason: 'no_name' });
  assert.deepEqual(
    mapOsmElement({ type: 'way', id: 10, tags: { amenity: 'bank', name: 'Bank' } }),
    { ok: false, reason: 'no_coordinates' },
  );
  // Pulau Pramuka, Kepulauan Seribu
  assert.deepEqual(
    mapOsmElement({ ...base, lat: -5.745, lon: 106.614, tags: { amenity: 'school', name: 'SD Pulau Pramuka' } }),
    { ok: false, reason: 'outside_area' },
  );
  assert.deepEqual(
    mapOsmElement({ ...base, tags: { amenity: 'bank', name: 'B'.repeat(201) } }),
    { ok: false, reason: 'field_too_long' },
  );
  assert.deepEqual(
    mapOsmElement({ ...base, tags: { amenity: 'bank', name: 'Bank', 'addr:full': 'A'.repeat(301) } }),
    { ok: false, reason: 'field_too_long' },
  );
  assert.deepEqual(mapOsmElement({ ...base, tags: { shop: 'convenience', name: 'Indomaret' } }), { ok: false, reason: 'no_category' });
});

test('PBI-09: perbandingan perubahan hanya menghitung data yang benar-benar berbeda', () => {
  const place: Omit<MappedPlace, 'osmType' | 'osmId'> = {
    name: 'Stasiun Manggarai',
    category: 'transportasi',
    address: '',
    latitude: -6.2099,
    longitude: 106.8502,
    accessibilityStatus: 'accessible',
    accessibilityAttributes: { wheelchair: 'yes', elevator: 'yes' },
    sourceUpdatedAt: '2026-09-01T00:00:00.000Z',
  };
  assert.equal(hasPlaceChanged(place, { ...place, accessibilityAttributes: { elevator: 'yes', wheelchair: 'yes' } }), false);
  assert.equal(hasPlaceChanged(place, { ...place, sourceUpdatedAt: '2026-09-01T00:00:00Z' }), false);
  assert.equal(hasPlaceChanged(place, { ...place, name: 'Stasiun Manggarai Baru' }), true);
  assert.equal(hasPlaceChanged(place, { ...place, accessibilityAttributes: { wheelchair: 'yes' } }), true);
  assert.equal(hasPlaceChanged(place, { ...place, latitude: -6.2100 }), true);
});

test('PBI-09: query Overpass hanya mengambil wilayah DKI Jakarta dengan titik tengah dan timestamp', () => {
  const query = buildOverpassQuery();
  assert.match(query, /area\["ISO3166-2"="ID-JK"\]\[admin_level=4\]->\.jkt;/);
  assert.match(query, /out center meta;/);
  // Query seluruh Jakarta butuh sekitar 95 detik, jadi batas lama 80 detik selalu gagal.
  assert.match(query, /\[timeout:170\]/);
  assert.match(query, /\["name"\]\(area\.jkt\)/);
});

test('PBI-09: normalisasi nama dan perkiraan jarak untuk deteksi duplikat', () => {
  assert.equal(normalizePlaceName('  Taman   SUROPATI '), 'taman suropati');
  const distance = approximateDistanceMeters(-6.2, 106.8, -6.2003, 106.8);
  assert.ok(distance > 30 && distance < 35, `jarak ${distance}`);
});
