import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createAdminPlacesRouter } from '../src/routes/admin-places.js';
import { OverpassUnavailableError, type OverpassFetcher } from '../src/services/overpass.js';
import { createInMemoryPlaceImportStore, type InMemoryPlaceImportStore } from '../src/services/place-import.js';

const ADMIN = 'Bearer admin-token';
const USER = 'Bearer user-token';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const elements = [
  { type: 'node', id: 11, lat: -6.1754, lon: 106.8272, tags: { tourism: 'museum', name: 'Museum Nasional', wheelchair: 'yes' } },
  { type: 'way', id: 12, center: { lat: -6.2, lon: 106.83 }, tags: { leisure: 'park', name: 'Taman Menteng' } },
];

function setup(fetchOverpass: OverpassFetcher = async () => ({ elements, endpoint: 'overpass.test' })) {
  const store = createInMemoryPlaceImportStore();
  const tasks: (() => Promise<void>)[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createAdminPlacesRouter({
    store,
    fetchOverpass,
    schedule: (task) => tasks.push(task),
    authResolver: async (req) => {
      const header = req.get('Authorization');
      if (header === ADMIN) return { id: '99999999-9999-4999-8999-999999999999', role: 'admin' };
      if (header === USER) return { id: '11111111-1111-4111-8111-111111111111', role: 'user' };
      return null;
    },
  }));
  app.use(errorHandler);
  const runScheduled = async () => {
    while (tasks.length) await tasks.shift()!();
  };
  return { app, store, runScheduled };
}

async function importPlaces(app: express.Express, runScheduled: () => Promise<void>) {
  await request(app).post('/api/admin/osm-imports').set('Authorization', ADMIN).expect(202);
  await runScheduled();
}

const endpoints: [method: 'get' | 'post' | 'patch' | 'delete', path: string][] = [
  ['post', '/api/admin/osm-imports'],
  ['get', '/api/admin/osm-imports'],
  ['get', `/api/admin/osm-imports/${MISSING_ID}`],
  ['get', '/api/admin/places'],
  ['get', '/api/admin/places/duplicates'],
  ['patch', `/api/admin/places/${MISSING_ID}`],
  ['delete', `/api/admin/places/${MISSING_ID}`],
  ['get', '/api/admin/notifications'],
  ['patch', `/api/admin/notifications/${MISSING_ID}/read`],
];

test('PBI-09: semua endpoint admin menolak tanpa token (401) dan pengguna biasa (403)', async () => {
  const { app } = setup();
  for (const [method, path] of endpoints) {
    const anonymous = await request(app)[method](path).expect(401);
    assert.equal(anonymous.body.error.code, 'UNAUTHORIZED', `${method} ${path}`);

    const user = await request(app)[method](path).set('Authorization', USER).expect(403);
    assert.equal(user.body.error.code, 'FORBIDDEN', `${method} ${path}`);
    assert.equal(user.headers['cache-control'], 'no-store');
  }
});

test('PBI-09: admin menjalankan impor (202), impor kedua saat masih berjalan ditolak (409)', async () => {
  const { app, runScheduled } = setup();

  const started = await request(app).post('/api/admin/osm-imports').set('Authorization', ADMIN).expect(202);
  assert.equal(started.body.data.status, 'queued');

  const conflict = await request(app).post('/api/admin/osm-imports').set('Authorization', ADMIN).expect(409);
  assert.equal(conflict.body.error.code, 'IMPORT_ALREADY_RUNNING');
  assert.match(conflict.body.error.message, /masih berjalan/);

  await runScheduled();
  const job = await request(app).get(`/api/admin/osm-imports/${started.body.data.id}`).set('Authorization', ADMIN).expect(200);
  assert.equal(job.body.data.status, 'succeeded');
  assert.equal(job.body.data.createdCount, 2);

  const history = await request(app).get('/api/admin/osm-imports?page=1&pageSize=5').set('Authorization', ADMIN).expect(200);
  assert.equal(history.body.data.total, 1);
  assert.equal(history.body.data.items[0].id, started.body.data.id);
});

test('PBI-09: daftar tempat hasil impor beserta atribut aksesibilitas dan filter', async () => {
  const { app, runScheduled } = setup();
  await importPlaces(app, runScheduled);

  const all = await request(app).get('/api/admin/places').set('Authorization', ADMIN).expect(200);
  assert.equal(all.body.data.total, 2);
  assert.equal(all.body.data.pageSize, 20);
  const museum = all.body.data.items.find((place: { name: string }) => place.name === 'Museum Nasional');
  assert.equal(museum.accessibilityStatus, 'accessible');
  assert.deepEqual(museum.accessibilityAttributes, { wheelchair: 'yes' });
  assert.equal(museum.dataSource, 'osm');
  assert.equal(museum.osmType, 'node');
  assert.equal(museum.osmId, 11);

  const filtered = await request(app)
    .get('/api/admin/places?q=taman&status=unknown&source=osm&page=1&pageSize=10')
    .set('Authorization', ADMIN).expect(200);
  assert.deepEqual(filtered.body.data.items.map((place: { name: string }) => place.name), ['Taman Menteng']);

  // Nilai kosong dari form GET dianggap tidak memfilter.
  const emptyFilters = await request(app).get('/api/admin/places?q=&status=&source=').set('Authorization', ADMIN).expect(200);
  assert.equal(emptyFilters.body.data.total, 2);
});

test('PBI-09: query dan parameter tidak valid ditolak dengan 400', async () => {
  const { app } = setup();
  const invalid = [
    '/api/admin/places?status=hijau',
    '/api/admin/places?source=google',
    '/api/admin/places?pageSize=500',
    '/api/admin/places?page=0',
    `/api/admin/places?q=${'a'.repeat(101)}`,
    '/api/admin/places?sort=name',
    '/api/admin/osm-imports?pageSize=abc',
    '/api/admin/osm-imports/bukan-uuid',
    '/api/admin/notifications?unread=ya',
  ];
  for (const path of invalid) {
    const response = await request(app).get(path).set('Authorization', ADMIN).expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR', path);
    assert.ok(response.body.error.message, path);
  }
  await request(app).delete('/api/admin/places/123').set('Authorization', ADMIN).expect(400);
  await request(app).patch('/api/admin/notifications/abc/read').set('Authorization', ADMIN).expect(400);
});

test('PBI-09: id yang tidak ditemukan dibalas 404', async () => {
  const { app } = setup();
  const job = await request(app).get(`/api/admin/osm-imports/${MISSING_ID}`).set('Authorization', ADMIN).expect(404);
  assert.equal(job.body.error.code, 'IMPORT_NOT_FOUND');
  const place = await request(app).delete(`/api/admin/places/${MISSING_ID}`).set('Authorization', ADMIN).expect(404);
  assert.equal(place.body.error.code, 'PLACE_NOT_FOUND');
  await request(app).patch(`/api/admin/places/${MISSING_ID}`).set('Authorization', ADMIN).send({ name: 'Baru' }).expect(404);
  const notification = await request(app).patch(`/api/admin/notifications/${MISSING_ID}/read`).set('Authorization', ADMIN).expect(404);
  assert.equal(notification.body.error.code, 'NOTIFICATION_NOT_FOUND');
});

test('PBI-09: admin mengubah nama dan info aksesibilitas tempat, input salah ditolak', async () => {
  const { app, store, runScheduled } = setup();
  await importPlaces(app, runScheduled);
  const park = store.allPlaces().find((place) => place.name === 'Taman Menteng')!;
  const path = `/api/admin/places/${park.id}`;

  const updated = await request(app).patch(path).set('Authorization', ADMIN).send({
    name: '  Taman Menteng Bintaro  ',
    accessibilityStatus: 'partial',
    accessibilityAttributes: { wheelchair: 'limited', ramp: 'yes', elevator: '' },
  }).expect(200);
  assert.equal(updated.body.data.name, 'Taman Menteng Bintaro');
  assert.equal(updated.body.data.accessibilityStatus, 'partial');
  assert.deepEqual(updated.body.data.accessibilityAttributes, { wheelchair: 'limited', ramp: 'yes' });
  assert.equal(updated.body.data.editedByAdmin, true);

  const invalidBodies = [
    {},
    { name: '   ' },
    { accessibilityStatus: 'hijau' },
    { latitude: -5.7, longitude: 106.6 },
    { latitude: -6.2 },
    { accessibilityAttributes: { parkir: 'ada' } },
    { dataSource: 'manual' },
  ];
  for (const body of invalidBodies) {
    const response = await request(app).patch(path).set('Authorization', ADMIN).send(body).expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
  }
});

test('PBI-09: hapus tempat memberi tahu jumlah lokasi tersimpan dan kontribusi yang ikut terhapus', async () => {
  const { app, store, runScheduled } = setup();
  await importPlaces(app, runScheduled);
  const museum = store.allPlaces().find((place) => place.name === 'Museum Nasional')!;
  store.setUsage(museum.id, { saved: 2, contributions: 1 });

  const list = await request(app).get('/api/admin/places?q=museum').set('Authorization', ADMIN).expect(200);
  assert.equal(list.body.data.items[0].savedCount, 2);
  assert.equal(list.body.data.items[0].contributionCount, 1);

  await request(app).delete(`/api/admin/places/${museum.id}`).set('Authorization', ADMIN)
    .send({ reason: 'bukan-alasan' }).expect(400);

  const deleted = await request(app).delete(`/api/admin/places/${museum.id}`).set('Authorization', ADMIN)
    .send({ reason: 'invalid' }).expect(200);
  assert.deepEqual(deleted.body.data, {
    id: museum.id,
    name: 'Museum Nasional',
    dataSource: 'osm',
    excluded: true,
    savedByCount: 2,
    contributionCount: 1,
  });
  await request(app).delete(`/api/admin/places/${museum.id}`).set('Authorization', ADMIN).expect(404);
});

test('PBI-09: kandidat duplikat berisi tempat bernama sama dalam jarak kurang dari 50 meter', async () => {
  const { app, store } = setup();
  store.seedPlace({ name: 'Taman Suropati', category: 'taman', latitude: -6.1994, longitude: 106.8326 });
  store.seedPlace({ name: '  taman   SUROPATI', dataSource: 'osm', osmType: 'way', osmId: 77, latitude: -6.1996, longitude: 106.8327 });
  store.seedPlace({ name: 'Taman Suropati', latitude: -6.25, longitude: 106.9 });

  const response = await request(app).get('/api/admin/places/duplicates').set('Authorization', ADMIN).expect(200);
  assert.equal(response.body.data.items.length, 1);
  const [pair] = response.body.data.items;
  assert.ok(pair.distanceMeters < 50);
  assert.equal(pair.places.length, 2);
});

test('PBI-09 (NFR-06): saat Overpass mati, job gagal tetapi daftar tempat tetap terbaca', async () => {
  let online = true;
  const { app, runScheduled } = setup(async () => {
    if (!online) throw new OverpassUnavailableError();
    return { elements, endpoint: 'overpass.test' };
  });
  await importPlaces(app, runScheduled);

  online = false;
  const started = await request(app).post('/api/admin/osm-imports').set('Authorization', ADMIN).expect(202);
  await runScheduled();

  const job = await request(app).get(`/api/admin/osm-imports/${started.body.data.id}`).set('Authorization', ADMIN).expect(200);
  assert.equal(job.body.data.status, 'failed');
  assert.match(job.body.data.errorMessage, /tidak dapat diakses/);

  const places = await request(app).get('/api/admin/places').set('Authorization', ADMIN).expect(200);
  assert.equal(places.body.data.total, 2);
});

test('PBI-10: notifikasi admin untuk impor berhasil dan gagal bisa ditandai dibaca', async () => {
  let online = true;
  const { app, runScheduled } = setup(async () => {
    if (!online) throw new OverpassUnavailableError();
    return { elements, endpoint: 'overpass.test' };
  });
  await importPlaces(app, runScheduled);
  online = false;
  await importPlaces(app, runScheduled);

  const all = await request(app).get('/api/admin/notifications').set('Authorization', ADMIN).expect(200);
  assert.equal(all.body.data.items.length, 2);
  assert.equal(all.body.data.unreadCount, 2);
  assert.deepEqual(all.body.data.items.map((item: { type: string }) => item.type).sort(), ['osm_import_failed', 'osm_import_succeeded']);

  const target = all.body.data.items[0];
  const read = await request(app).patch(`/api/admin/notifications/${target.id}/read`).set('Authorization', ADMIN).expect(200);
  assert.equal(read.body.data.isRead, true);

  const unread = await request(app).get('/api/admin/notifications?unread=true').set('Authorization', ADMIN).expect(200);
  assert.equal(unread.body.data.items.length, 1);
  assert.equal(unread.body.data.unreadCount, 1);
});
