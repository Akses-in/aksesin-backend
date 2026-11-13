import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createPlacesRouter } from '../src/routes/places.js';
import { createInMemoryPublicPlacesReader, type PublicPlace } from '../src/services/public-places.js';

const JAKARTA_CENTER = '106.80,-6.22,106.86,-6.16';

function place(id: number, overrides: Partial<PublicPlace> = {}): PublicPlace {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    name: `Tempat ${id}`,
    category: 'kesehatan',
    address: '',
    latitude: -6.19,
    longitude: 106.83,
    accessibilityStatus: 'unknown',
    accessibilityAttributes: {},
    dataSource: 'osm',
    osmType: 'node',
    osmId: id,
    sourceUpdatedAt: null,
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  };
}

function setup(places: PublicPlace[]) {
  const app = express();
  app.use('/api', createPlacesRouter({ reader: createInMemoryPublicPlacesReader(places) }));
  app.use(errorHandler);
  return app;
}

test('PBI-05: daftar tempat publik dapat dibaca tanpa login dan hanya berisi tempat di dalam bbox', async () => {
  const app = setup([
    place(1, { name: 'RS Dalam Area' }),
    place(2, { name: 'Taman Luar Area', latitude: -6.35, longitude: 106.9 }),
  ]);

  const response = await request(app).get(`/api/places?bbox=${JAKARTA_CENTER}`).expect(200);
  assert.deepEqual(response.body.data.items.map((item: PublicPlace) => item.name), ['RS Dalam Area']);
  assert.equal(response.body.data.truncated, false);
  assert.equal(response.headers['cache-control'], 'public, max-age=60');

  const [item] = response.body.data.items;
  assert.equal('savedCount' in item, false, 'jumlah penyimpan tidak boleh tampil di endpoint publik');
});

test('PBI-05: filter status dan urutan mendahulukan tempat yang punya informasi aksesibilitas', async () => {
  const app = setup([
    place(1, { name: 'A Unknown' }),
    place(2, { name: 'B Partial', accessibilityStatus: 'partial' }),
    place(3, { name: 'C Accessible', accessibilityStatus: 'accessible' }),
  ]);

  const all = await request(app).get(`/api/places?bbox=${JAKARTA_CENTER}`).expect(200);
  assert.deepEqual(all.body.data.items.map((item: PublicPlace) => item.name), ['C Accessible', 'B Partial', 'A Unknown']);

  const partial = await request(app).get(`/api/places?bbox=${JAKARTA_CENTER}&status=partial`).expect(200);
  assert.deepEqual(partial.body.data.items.map((item: PublicPlace) => item.name), ['B Partial']);
});

test('PBI-05: hasil dipotong sesuai limit dan memberi tanda truncated', async () => {
  const app = setup(Array.from({ length: 5 }, (_, i) => place(i + 1)));
  const response = await request(app).get(`/api/places?bbox=${JAKARTA_CENTER}&limit=3`).expect(200);
  assert.equal(response.body.data.items.length, 3);
  assert.equal(response.body.data.truncated, true);
});

test('PBI-05: bbox, status, dan limit yang tidak valid ditolak dengan 400', async () => {
  const app = setup([]);
  const invalid = [
    '/api/places',
    '/api/places?bbox=',
    '/api/places?bbox=106.8,-6.2,106.9',
    '/api/places?bbox=106.9,-6.2,106.8,-6.1',
    '/api/places?bbox=a,b,c,d',
    '/api/places?bbox=200,-6.2,210,-6.1',
    `/api/places?bbox=${JAKARTA_CENTER}&status=hijau`,
    `/api/places?bbox=${JAKARTA_CENTER}&limit=501`,
    `/api/places?bbox=${JAKARTA_CENTER}&q=rs`,
  ];
  for (const path of invalid) {
    const response = await request(app).get(path).expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR', path);
  }
});

test('PBI-05: skema database belum diterapkan dibalas 503 yang jelas', async () => {
  const app = express();
  app.use('/api', createPlacesRouter({
    reader: {
      listInBounds: async () => {
        throw Object.assign(new Error('Raw query failed'), {
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: '42703', kind: 'ColumnNotFound' } } },
        });
      },
    },
  }));
  app.use(errorHandler);

  const response = await request(app).get(`/api/places?bbox=${JAKARTA_CENTER}`).expect(503);
  assert.equal(response.body.error.code, 'IMPORT_SCHEMA_MISSING');
});
