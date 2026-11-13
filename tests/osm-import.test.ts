import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OVERPASS_USER_AGENT,
  OverpassUnavailableError,
  createOverpassFetcher,
  fetchOverpassElements,
  type OverpassFetcher,
} from '../src/services/overpass.js';
import {
  IMPORT_MESSAGES,
  PlaceImportError,
  createInMemoryPlaceImportStore,
  failInterruptedImportJobs,
  runOsmImport,
  type InMemoryPlaceImportStore,
} from '../src/services/place-import.js';

const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

function hospital(id: number, overrides: Record<string, string> = {}) {
  return {
    type: 'node',
    id,
    lat: -6.19 - id / 100_000,
    lon: 106.82,
    timestamp: '2026-10-01T00:00:00Z',
    tags: { amenity: 'hospital', name: `RS Uji ${id}`, wheelchair: 'yes', ...overrides },
  };
}

const fixedFetcher = (elements: unknown[]): OverpassFetcher => async () => ({ elements, endpoint: 'overpass.test' });

async function importOnce(store: InMemoryPlaceImportStore, fetcher: OverpassFetcher) {
  const job = await store.createJob(ADMIN_ID);
  await runOsmImport(store, job.id, fetcher);
  const finished = await store.getJob(job.id);
  assert.ok(finished);
  return finished;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('PBI-09: impor pertama membuat tempat baru dan job berhasil', async () => {
  const store = createInMemoryPlaceImportStore();
  const job = await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));

  assert.equal(job.status, 'succeeded');
  assert.equal(job.fetchedCount, 2);
  assert.equal(job.createdCount, 2);
  assert.equal(job.updatedCount, 0);
  assert.equal(job.sourceEndpoint, 'overpass.test');
  assert.ok(job.startedAt && job.finishedAt);

  const places = store.allPlaces();
  assert.equal(places.length, 2);
  assert.ok(places.every((place) => place.dataSource === 'osm' && place.accessibilityStatus === 'accessible'));
});

test('PBI-09: impor ulang data sama -> unchanged, data berubah -> updated, tanpa data dobel', async () => {
  const store = createInMemoryPlaceImportStore();
  await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));

  const same = await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));
  assert.equal(same.createdCount, 0);
  assert.equal(same.updatedCount, 0);
  assert.equal(same.unchangedCount, 2);

  const changed = await importOnce(store, fixedFetcher([
    hospital(1, { wheelchair: 'limited' }),
    hospital(2),
    hospital(3),
  ]));
  assert.equal(changed.createdCount, 1);
  assert.equal(changed.updatedCount, 1);
  assert.equal(changed.unchangedCount, 1);

  const places = store.allPlaces();
  assert.equal(places.length, 3);
  assert.equal(places.find((place) => place.osmId === 1)?.accessibilityStatus, 'partial');
});

test('PBI-09: elemen tidak valid dilewati dan dihitung per alasan', async () => {
  const store = createInMemoryPlaceImportStore();
  const job = await importOnce(store, fixedFetcher([
    hospital(1),
    hospital(1),
    { type: 'node' },
    { type: 'node', id: 5, lat: -6.2, lon: 106.8, tags: { amenity: 'hospital' } },
    { type: 'node', id: 6, lat: -5.74, lon: 106.61, tags: { amenity: 'school', name: 'SD Pulau' } },
    { type: 'way', id: 7, tags: { amenity: 'school', name: 'SD Tanpa Koordinat' } },
  ]));

  assert.equal(job.status, 'succeeded');
  assert.equal(job.fetchedCount, 6);
  assert.equal(job.createdCount, 1);
  assert.equal(job.skippedCount, 5);
  assert.deepEqual(job.skipBreakdown, {
    duplicate_in_response: 1,
    invalid_element: 1,
    no_name: 1,
    outside_area: 1,
    no_coordinates: 1,
  });
});

test('PBI-09: data manual tidak disentuh impor', async () => {
  const store = createInMemoryPlaceImportStore();
  const manual = store.seedPlace({
    name: 'RS Uji 1',
    category: 'kesehatan',
    address: 'Alamat manual',
    latitude: -6.19001,
    longitude: 106.82,
  });

  const job = await importOnce(store, fixedFetcher([hospital(1)]));
  assert.equal(job.createdCount, 1);

  const stored = store.allPlaces().find((place) => place.id === manual.id);
  assert.deepEqual(stored, manual);
});

test('PBI-09: hasil edit admin tidak ditimpa impor ulang', async () => {
  const store = createInMemoryPlaceImportStore();
  await importOnce(store, fixedFetcher([hospital(1)]));
  const [place] = store.allPlaces();
  assert.ok(place);

  await store.updatePlace(place.id, { name: 'RS Uji Satu (diperbaiki admin)', accessibilityStatus: 'partial' });
  const job = await importOnce(store, fixedFetcher([hospital(1, { name: 'Nama dari OSM' })]));

  assert.equal(job.updatedCount, 0);
  assert.equal(job.skipBreakdown.edited_by_admin, 1);
  const stored = store.allPlaces()[0];
  assert.equal(stored?.name, 'RS Uji Satu (diperbaiki admin)');
  assert.equal(stored?.accessibilityStatus, 'partial');
  assert.equal(stored?.editedByAdmin, true);
});

test('PBI-09: tempat OSM yang dihapus masuk exclusions dan tidak muncul lagi saat impor', async () => {
  const store = createInMemoryPlaceImportStore();
  await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));
  const target = store.allPlaces().find((place) => place.osmId === 1);
  assert.ok(target);
  store.setUsage(target.id, { saved: 3, contributions: 1 });

  const deleted = await store.deletePlace(target.id, ADMIN_ID, 'duplicate');
  assert.deepEqual(deleted, {
    id: target.id,
    name: target.name,
    dataSource: 'osm',
    excluded: true,
    savedByCount: 3,
    contributionCount: 1,
  });
  assert.deepEqual(store.exclusionKeys(), ['node/1']);

  const job = await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));
  assert.equal(job.createdCount, 0);
  assert.equal(job.skipBreakdown.excluded, 1);
  assert.equal(store.allPlaces().some((place) => place.osmId === 1), false);
});

test('PBI-09: endpoint utama gagal lalu endpoint cadangan berhasil', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await fetchOverpassElements({
    urls: ['https://utama.test/api/interpreter', 'https://cadangan.test/api/interpreter'],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.includes('utama') ? new Response('Too Many Requests', { status: 429 }) : jsonResponse({ elements: [hospital(1)] });
    },
  });

  assert.equal(result.endpoint, 'cadangan.test');
  assert.equal(result.elements.length, 1);
  assert.equal(calls.length, 2);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['User-Agent'], OVERPASS_USER_AGENT);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.ok(String(calls[0]!.init.body).startsWith('data='));
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test('PBI-09: timeout, JSON rusak, dan remark runtime error memicu endpoint berikutnya', async () => {
  const responses = [
    async () => { throw new DOMException('Timeout', 'TimeoutError'); },
    async () => new Response('<html>bukan json</html>', { status: 200 }),
    async () => jsonResponse({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }),
    async () => jsonResponse({ elements: [hospital(4)] }),
  ];
  const result = await fetchOverpassElements({
    urls: ['https://a.test/i', 'https://b.test/i', 'https://c.test/i', 'https://d.test/i'],
    fetchImpl: async () => responses.shift()!(),
  });
  assert.equal(result.endpoint, 'd.test');
});

test('PBI-09 (NFR-06): semua endpoint Overpass gagal -> job gagal, data lama utuh, daftar tetap terbaca', async () => {
  const store = createInMemoryPlaceImportStore();
  await importOnce(store, fixedFetcher([hospital(1), hospital(2)]));
  store.seedPlace({ name: 'Taman Manual', category: 'taman' });
  const before = store.allPlaces();

  const offline = createOverpassFetcher({
    urls: ['https://utama.test/i', 'https://cadangan.test/i'],
    fetchImpl: async () => new Response('Service Unavailable', { status: 503 }),
  });
  await assert.rejects(offline(), OverpassUnavailableError);

  const job = await importOnce(store, offline);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorMessage, IMPORT_MESSAGES.overpassUnavailable);
  assert.doesNotMatch(job.errorMessage ?? '', /503|utama\.test|Service Unavailable/);
  assert.deepEqual(store.allPlaces(), before);

  const list = await store.listPlaces({ page: 1, pageSize: 20 });
  assert.equal(list.total, 3);
});

test('PBI-09: respons Overpass kosong dianggap gagal dan tidak mengubah data', async () => {
  const store = createInMemoryPlaceImportStore();
  await importOnce(store, fixedFetcher([hospital(1)]));
  const before = store.allPlaces();

  const job = await importOnce(store, fixedFetcher([]));
  assert.equal(job.status, 'failed');
  assert.equal(job.errorMessage, IMPORT_MESSAGES.emptyResponse);
  assert.deepEqual(store.allPlaces(), before);
});

test('PBI-09: hanya satu job impor yang boleh aktif', async () => {
  const store = createInMemoryPlaceImportStore();
  await store.createJob(ADMIN_ID);
  await assert.rejects(
    store.createJob(ADMIN_ID),
    (error: unknown) => error instanceof PlaceImportError && error.status === 409 && error.code === 'IMPORT_ALREADY_RUNNING',
  );
});

test('PBI-10: setiap job selesai membuat tepat satu notifikasi dan bisa ditandai dibaca', async () => {
  const store = createInMemoryPlaceImportStore();
  const succeeded = await importOnce(store, fixedFetcher([hospital(1)]));
  const failed = await importOnce(store, async () => { throw new OverpassUnavailableError(); });

  // Pemanggilan ulang pada job yang sudah selesai tidak membuat notifikasi baru.
  await store.completeJob(succeeded.id, { ...succeeded }, 'overpass.test');
  await store.failJob(failed.id, 'pesan lain');

  const notifications = store.allNotifications();
  assert.equal(notifications.length, 2);
  const success = notifications.find((item) => item.jobId === succeeded.id);
  const failure = notifications.find((item) => item.jobId === failed.id);
  assert.equal(success?.type, 'osm_import_succeeded');
  assert.equal(success?.title, 'Impor OSM berhasil');
  assert.match(success?.message ?? '', /1 data diambil dari OSM: 1 baru, 0 diperbarui/);
  assert.equal(failure?.type, 'osm_import_failed');
  assert.equal(failure?.message, IMPORT_MESSAGES.overpassUnavailable);

  const unread = await store.listNotifications(true);
  assert.equal(unread.unreadCount, 2);

  const read = await store.markNotificationRead(success!.id);
  assert.equal(read?.isRead, true);
  assert.ok(read?.readAt);
  const after = await store.listNotifications(true);
  assert.equal(after.unreadCount, 1);
  assert.deepEqual(after.items.map((item) => item.id), [failure!.id]);
  assert.equal(await store.markNotificationRead('00000000-0000-4000-8000-000000000000'), null);
});

test('PBI-10: job yang terhenti saat server restart ditandai gagal dengan notifikasi', async () => {
  const store = createInMemoryPlaceImportStore();
  const job = await store.createJob(ADMIN_ID);
  await store.markJobRunning(job.id);

  assert.equal(await failInterruptedImportJobs(store), 1);
  const stored = await store.getJob(job.id);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.errorMessage, 'Impor terhenti karena server dimulai ulang.');
  assert.equal(store.allNotifications().length, 1);

  // Job baru boleh dibuat lagi setelah job lama dihentikan.
  await assert.doesNotReject(store.createJob(ADMIN_ID));
});
