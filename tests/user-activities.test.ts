import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createUserActivitiesRouter } from '../src/routes/user-activities.js';
import {
  createCommentSchema,
  createContributionSchema,
  createInMemoryActivityStore,
} from '../src/services/user-activity.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const POST_1 = '33333333-3333-4333-8333-333333333333';
const PLACE_1 = '44444444-4444-4444-8444-444444444444';

function buildTestApp(currentUserId: string | null = USER_A, initialStore = createInMemoryActivityStore()) {
  const app = express();
  app.use(express.json());

  const router = createUserActivitiesRouter({
    store: initialStore,
    authResolver: async () => (currentUserId ? { id: currentUserId, role: 'user' } : null),
  });

  app.use('/api', router);
  return { app, store: initialStore };
}

test('PBI-21 / Subtask 1: menolak akses riwayat aktivitas tanpa autentikasi (401 UNAUTHORIZED)', async () => {
  const { app } = buildTestApp(null);
  const response = await request(app).get('/api/me/activities');

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
  assert.ok(response.body.error.message.includes('Sesi tidak valid'));
});

test('PBI-21 / Subtask 1: menampilkan daftar riwayat aktivitas kosong dengan struktur data yang valid', async () => {
  const { app } = buildTestApp(USER_A);
  const response = await request(app).get('/api/me/activities');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.items, []);
  assert.equal(response.body.data.total, 0);
  assert.equal(response.body.data.summary.totalActivities, 0);
  assert.equal(response.body.data.summary.totalComments, 0);
  assert.equal(response.body.data.summary.totalContributions, 0);
});

test('PBI-21 / Subtask 1: isolasi hak akses (User A tidak dapat melihat komentar atau kontribusi milik User B)', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1111111-1111-4111-8111-111111111111',
        userId: USER_B,
        postId: POST_1,
        postTitle: 'Postingan Komunitas User B',
        content: 'Komentar rahasia milik User B',
        createdAt: '2026-11-10T10:00:00Z',
      },
    ],
    contributions: [
      {
        id: 'r1111111-1111-4111-8111-111111111111',
        userId: USER_B,
        placeId: PLACE_1,
        placeName: 'Lokasi Rahasia User B',
        placeAddress: 'Jl. Rahasia',
        placeCategory: 'Publik',
        status: 'approved',
        notes: 'Review fasilitas milik User B',
        rejectionReason: null,
        createdAt: '2026-11-10T11:00:00Z',
      },
    ],
  });

  // User A requests activities
  const { app: appA } = buildTestApp(USER_A, store);
  const responseA = await request(appA).get('/api/me/activities');

  assert.equal(responseA.status, 200);
  assert.equal(responseA.body.data.items.length, 0);
  assert.equal(responseA.body.data.total, 0);

  // User B requests activities
  const { app: appB } = buildTestApp(USER_B, store);
  const responseB = await request(appB).get('/api/me/activities');

  assert.equal(responseB.status, 200);
  assert.equal(responseB.body.data.items.length, 2);
  assert.equal(responseB.body.data.total, 2);
  assert.equal(responseB.body.data.summary.totalComments, 1);
  assert.equal(responseB.body.data.summary.totalContributions, 1);
});

test('PBI-21 / Subtask 1: mengembalikan riwayat komentar dan kontribusi review lokasi berurutan kronologis terbaru', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1111111-1111-4111-8111-111111111111',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Diskusi Ramp Halte',
        content: 'Ramp di halte ini sudah cukup landai dan ramah kursi roda.',
        createdAt: '2026-11-10T08:00:00Z',
      },
    ],
    contributions: [
      {
        id: 'r1111111-1111-4111-8111-111111111111',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Stasiun MRT Bundaran HI',
        placeAddress: 'Jl. M.H. Thamrin',
        placeCategory: 'Stasiun MRT',
        status: 'approved',
        notes: 'Tersedia lift prioritas aktif dan guiding block tactile lengkap.',
        rejectionReason: null,
        createdAt: '2026-11-10T09:30:00Z', // newer than comment
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const response = await request(app).get('/api/me/activities');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.items.length, 2);

  // First item must be the newer contribution
  assert.equal(response.body.data.items[0].type, 'contribution');
  assert.equal(response.body.data.items[0].placeName, 'Stasiun MRT Bundaran HI');
  assert.equal(response.body.data.items[0].status, 'approved');
  assert.equal(response.body.data.items[0].statusLabel, 'Disetujui');

  // Second item is the older comment
  assert.equal(response.body.data.items[1].type, 'comment');
  assert.equal(response.body.data.items[1].postTitle, 'Diskusi Ramp Halte');
  assert.ok(response.body.data.items[1].content.includes('Ramp di halte'));
});

test('PBI-21 / Subtask 1: filter riwayat berdasarkan tipe (type=comment dan type=contribution)', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1111111-1111-4111-8111-111111111111',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Diskusi Toilet Disabilitas',
        content: 'Toilet disabilitas bersih dan memiliki pegangan rambat.',
        createdAt: '2026-11-10T08:00:00Z',
      },
    ],
    contributions: [
      {
        id: 'r1111111-1111-4111-8111-111111111111',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Taman Suropati',
        placeAddress: 'Menteng, Jakarta Pusat',
        placeCategory: 'Taman',
        status: 'pending',
        notes: 'Jalur pejalan kaki sudah dilengkapi guiding block kuning.',
        rejectionReason: null,
        createdAt: '2026-11-10T09:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);

  // Filter type=comment
  const commentRes = await request(app).get('/api/me/activities?type=comment');
  assert.equal(commentRes.status, 200);
  assert.equal(commentRes.body.data.items.length, 1);
  assert.equal(commentRes.body.data.items[0].type, 'comment');

  // Filter type=contribution
  const contribRes = await request(app).get('/api/me/activities?type=contribution');
  assert.equal(contribRes.status, 200);
  assert.equal(contribRes.body.data.items.length, 1);
  assert.equal(contribRes.body.data.items[0].type, 'contribution');
});

test('PBI-21 / Subtask 1: pagination (limit dan offset) berjalan dengan tepat', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 1',
        content: 'Komentar 1',
        createdAt: '2026-11-10T01:00:00Z',
      },
      {
        id: 'c2',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 2',
        content: 'Komentar 2',
        createdAt: '2026-11-10T02:00:00Z',
      },
      {
        id: 'c3',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 3',
        content: 'Komentar 3',
        createdAt: '2026-11-10T03:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);

  const page1 = await request(app).get('/api/me/activities?limit=2&offset=0');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(page1.body.data.total, 3);
  assert.equal(page1.body.data.items[0].id, 'c3'); // newest
  assert.equal(page1.body.data.items[1].id, 'c2');

  const page2 = await request(app).get('/api/me/activities?limit=2&offset=2');
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.items.length, 1);
  assert.equal(page2.body.data.items[0].id, 'c1');
});

test('PBI-21 / Subtask 1: endpoint summary mengembalikan total aktivitas, komentar, dan kontribusi', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 1',
        content: 'Komentar 1',
        createdAt: '2026-11-10T01:00:00Z',
      },
    ],
    contributions: [
      {
        id: 'r1',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Lokasi 1',
        placeAddress: 'Alamat',
        placeCategory: 'Publik',
        status: 'pending',
        notes: 'Catatan 1',
        rejectionReason: null,
        createdAt: '2026-11-10T02:00:00Z',
      },
      {
        id: 'r2',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Lokasi 2',
        placeAddress: 'Alamat',
        placeCategory: 'Publik',
        status: 'approved',
        notes: 'Catatan 2',
        rejectionReason: null,
        createdAt: '2026-11-10T03:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const response = await request(app).get('/api/me/activities/summary');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    totalActivities: 3,
    totalComments: 1,
    totalContributions: 2,
  });
});

test('PBI-21 / Subtask 1: validasi input pembuatan komentar dan kontribusi', () => {
  // Invalid comment: empty content
  const emptyComment = createCommentSchema.safeParse({
    postId: POST_1,
    content: '   ',
  });
  assert.equal(emptyComment.success, false);

  // Invalid comment: bad UUID
  const badUuidComment = createCommentSchema.safeParse({
    postId: 'invalid-uuid',
    content: 'Komentar valid',
  });
  assert.equal(badUuidComment.success, false);

  // Valid comment
  const validComment = createCommentSchema.safeParse({
    postId: POST_1,
    content: 'Komentar yang valid',
  });
  assert.equal(validComment.success, true);

  // Invalid contribution: too short notes (< 3 chars)
  const shortNotes = createContributionSchema.safeParse({
    placeId: PLACE_1,
    notes: 'ab',
  });
  assert.equal(shortNotes.success, false);

  // Valid contribution
  const validContrib = createContributionSchema.safeParse({
    placeId: PLACE_1,
    notes: 'Tersedia ramp kursi roda di pintu barat.',
    status: 'pending',
  });
  assert.equal(validContrib.success, true);
});

test('PBI-21 / Subtask 2: mengambil daftar lokasi tersimpan hanya milik user yang sedang login', async () => {
  const store = createInMemoryActivityStore({
    savedPlaces: [
      {
        id: 's1',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Stasiun MRT Bundaran HI',
        placeAddress: 'Jl. M.H. Thamrin',
        placeCategory: 'Stasiun MRT',
        createdAt: '2026-11-10T10:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const response = await request(app).get('/api/me/saved-places');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].placeName, 'Stasiun MRT Bundaran HI');
  assert.equal(response.body.data[0].userId, USER_A);
});

test('PBI-21 / Subtask 2: isolasi data lokasi tersimpan (User A tidak bisa melihat lokasi tersimpan milik User B)', async () => {
  const store = createInMemoryActivityStore({
    savedPlaces: [
      {
        id: 's-b1',
        userId: USER_B,
        placeId: PLACE_1,
        placeName: 'Lokasi Rahasia User B',
        placeAddress: 'Jl. Rahasia',
        placeCategory: 'Umum',
        createdAt: '2026-11-10T10:00:00Z',
      },
    ],
  });

  const { app: appA } = buildTestApp(USER_A, store);
  const responseA = await request(appA).get('/api/me/saved-places');
  assert.equal(responseA.status, 200);
  assert.equal(responseA.body.data.length, 0);

  const { app: appB } = buildTestApp(USER_B, store);
  const responseB = await request(appB).get('/api/me/saved-places');
  assert.equal(responseB.status, 200);
  assert.equal(responseB.body.data.length, 1);
  assert.equal(responseB.body.data[0].placeName, 'Lokasi Rahasia User B');
});

test('PBI-21 / Subtask 2: menghapus lokasi tersimpan milik sendiri', async () => {
  const savedId = '11111111-2222-4333-8444-555555555555';
  const store = createInMemoryActivityStore({
    savedPlaces: [
      {
        id: savedId,
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Stasiun MRT Bundaran HI',
        placeAddress: 'Jl. M.H. Thamrin',
        placeCategory: 'Stasiun MRT',
        createdAt: '2026-11-10T10:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const deleteRes = await request(app).delete(`/api/me/saved-places/${savedId}`);
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.data.success, true);

  const listRes = await request(app).get('/api/me/saved-places');
  assert.equal(listRes.body.data.length, 0);
});

test('PBI-21 / Subtask 2: endpoint profile-summary menghitung total saved places dengan benar', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 1',
        content: 'Komentar 1',
        createdAt: '2026-11-10T01:00:00Z',
      },
    ],
    contributions: [
      {
        id: 'r1',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Lokasi 1',
        placeAddress: 'Alamat',
        placeCategory: 'Publik',
        status: 'approved',
        notes: 'Catatan 1',
        rejectionReason: null,
        createdAt: '2026-11-10T02:00:00Z',
      },
    ],
    savedPlaces: [
      {
        id: 's1',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Lokasi 1',
        placeAddress: 'Alamat',
        placeCategory: 'Publik',
        createdAt: '2026-11-10T03:00:00Z',
      },
      {
        id: 's2',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Lokasi 2',
        placeAddress: 'Alamat 2',
        placeCategory: 'Publik',
        createdAt: '2026-11-10T04:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const res = await request(app).get('/api/me/profile-summary');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    totalActivities: 2,
    totalComments: 1,
    totalContributions: 1,
    totalSavedPlaces: 2,
  });
});

test('PBI-21 / Subtask 2: endpoint overview mengembalikan riwayat aktivitas dan lokasi tersimpan dalam satu respon', async () => {
  const store = createInMemoryActivityStore({
    comments: [
      {
        id: 'c1',
        userId: USER_A,
        postId: POST_1,
        postTitle: 'Post 1',
        content: 'Komentar 1',
        createdAt: '2026-11-10T01:00:00Z',
      },
    ],
    savedPlaces: [
      {
        id: 's1',
        userId: USER_A,
        placeId: PLACE_1,
        placeName: 'Stasiun MRT',
        placeAddress: 'Jl. Sudirman',
        placeCategory: 'Stasiun',
        createdAt: '2026-11-10T02:00:00Z',
      },
    ],
  });

  const { app } = buildTestApp(USER_A, store);
  const res = await request(app).get('/api/me/overview');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.activities.length, 1);
  assert.equal(res.body.data.activities[0].content, 'Komentar 1');
  assert.equal(res.body.data.savedPlaces.length, 1);
  assert.equal(res.body.data.savedPlaces[0].placeName, 'Stasiun MRT');
  assert.equal(res.body.data.summary.totalComments, 1);
  assert.equal(res.body.data.summary.totalSavedPlaces, 1);
});

