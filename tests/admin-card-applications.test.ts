import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createAdminCardApplicationsRouter } from '../src/routes/admin-card-applications.js';
import {
  createCardApplicationSchema,
  createInMemoryCardStore,
  type CardApplicationStore,
} from '../src/services/card-application.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';
const MISSING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const sampleDoc = {
  documentType: 'surat_keterangan' as const,
  fileName: 'surat-disabilitas.pdf',
  mimeType: 'application/pdf' as const,
  fileSize: Buffer.byteLength('PDF-1.4-admin-review-test'),
  contentBase64: Buffer.from('PDF-1.4-admin-review-test').toString('base64'),
};

function makeApp(store: CardApplicationStore) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api',
    createAdminCardApplicationsRouter({
      store,
      publicBaseUrl: 'http://localhost:3001',
      authResolver: async (req) => {
        const token = req.get('Authorization')?.replace(/^Bearer /i, '');
        if (token === 'admin') return { id: ADMIN_ID, role: 'admin', name: 'Admin Verifikator' };
        if (token === 'user-a') return { id: USER_A, role: 'user', name: 'Hafiz Afra' };
        if (token === 'user-b') return { id: USER_B, role: 'user', name: 'Budi Santoso' };
        return null;
      },
    }),
  );
  app.use(errorHandler);
  return app;
}

async function seedApplication(store: CardApplicationStore, userId: string, fullName: string) {
  const input = createCardApplicationSchema.parse({
    fullName,
    disabilityCategory: 'fisik',
    needs: ['step_free', 'priority_seating'],
    notes: 'Butuh akses kursi roda.',
    consentGiven: true,
    document: sampleDoc,
  });
  return (await store.create(userId, input)).application;
}

test('PBI-19 & PBI-20 RBAC: menolak guest (401) dan non-admin (403) pada semua endpoint admin kartu', async () => {
  const store = createInMemoryCardStore();
  const created = await seedApplication(store, USER_A, 'Hafiz Afra Riata');
  const docId = created.documents[0]!.id;
  const app = makeApp(store);

  const adminRoutes: Array<{ method: 'get' | 'post'; path: string; body?: object }> = [
    { method: 'get', path: '/api/admin/card-applications' },
    { method: 'get', path: `/api/admin/card-applications/${created.id}` },
    { method: 'get', path: `/api/admin/card-applications/${created.id}/documents/${docId}` },
    { method: 'post', path: `/api/admin/card-applications/${created.id}/decision`, body: { decision: 'diproses', reason: '' } },
    { method: 'post', path: `/api/admin/card-applications/${created.id}/renew`, body: { validityMonths: 12 } },
    { method: 'post', path: `/api/admin/card-applications/${created.id}/revoke`, body: { reason: 'Dokumen palsu', confirm: true } },
  ];

  for (const route of adminRoutes) {
    await request(app)[route.method](route.path).send(route.body).expect(401);
    const forbidden = await request(app)[route.method](route.path)
      .set('Authorization', 'Bearer user-a')
      .send(route.body)
      .expect(403);
    assert.equal(forbidden.body.error.code, 'FORBIDDEN_ROLE');
  }
});

test('PBI-19: alur lengkap verifikasi, pratinjau dokumen admin, penerbitan kartu + QR, perpanjangan, dan pencabutan', async () => {
  const store = createInMemoryCardStore();
  const created = await seedApplication(store, USER_A, 'Siti Rahmawati');
  const docId = created.documents[0]!.id;
  const app = makeApp(store);

  // Admin dapat melihat pratinjau dokumen pendukung
  const docRes = await request(app)
    .get(`/api/admin/card-applications/${created.id}/documents/${docId}`)
    .set('Authorization', 'Bearer admin')
    .expect(200)
    .expect('Content-Type', 'application/pdf')
    .expect('Content-Disposition', 'inline');
  assert.ok(docRes.body);

  // 1. Admin menandai sedang diproses
  const procRes = await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'diproses', reason: 'Memeriksa keabsahan surat keterangan.' })
    .expect(200);
  assert.equal(procRes.body.data.status, 'diproses');
  assert.equal(procRes.body.data.issuedCard, null);

  // 2. Admin menyetujui & menerbitkan kartu dengan masa berlaku 12 bulan
  const approveRes = await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'verified', reason: 'Dokumen lengkap dan sesuai.', validityMonths: 12 })
    .expect(200);

  const issued = approveRes.body.data.issuedCard;
  assert.ok(issued);
  assert.match(issued.cardNumber, /^DAC-\d{4}-[0-9A-Z]{8}$/);
  assert.match(issued.qrToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(issued.state, 'active');

  // QR SVG hanya boleh diakses pemilik atau admin
  await request(app).get(`/api/card-applications/${created.id}/qr`).set('Authorization', 'Bearer user-b').expect(403);
  const qrRes = await request(app)
    .get(`/api/card-applications/${created.id}/qr`)
    .set('Authorization', 'Bearer user-a')
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', done);
    })
    .expect(200)
    .expect('Content-Type', /image\/svg\+xml/);
  assert.ok(String(qrRes.body).includes('<svg'));

  // Verifikasi publik QR mengembalikan status valid tanpa membuka dokumen atau catatan sensitif
  const publicVerify = await request(app)
    .get(`/api/cards/verify/${issued.qrToken}`)
    .expect(200);
  assert.equal(publicVerify.body.data.valid, true);
  assert.equal(publicVerify.body.data.state, 'active');
  assert.equal(publicVerify.body.data.holderName, 'Siti Rahmawati');
  assert.equal(publicVerify.body.data.cardNumber, issued.cardNumber);
  assert.equal(publicVerify.body.data.documents, undefined);
  assert.equal(publicVerify.body.data.notes, undefined);

  // Endpoint QR SVG publik dapat diakses tanpa login untuk token valid, menolak token tidak terdaftar (404) & cacat (400)
  const publicQrRes = await request(app)
    .get(`/api/cards/verify/${issued.qrToken}/qr`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', done);
    })
    .expect(200)
    .expect('Content-Type', /image\/svg\+xml/);
  assert.ok(String(publicQrRes.body).includes('<svg'));

  await request(app)
    .get('/api/cards/verify/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/qr')
    .expect(404);
  await request(app)
    .get('/api/cards/verify/short/qr')
    .expect(400);

  // 3. Perpanjang masa berlaku 6 bulan
  const renewRes = await request(app)
    .post(`/api/admin/card-applications/${created.id}/renew`)
    .set('Authorization', 'Bearer admin')
    .send({ validityMonths: 6, reason: 'Perpanjangan rutin tahunan.' })
    .expect(200);
  assert.ok(
    new Date(renewRes.body.data.issuedCard.expiresAt).getTime() >
    new Date(issued.expiresAt).getTime(),
  );

  // 4. Cabut kartu dengan konfirmasi & alasan
  const revokeRes = await request(app)
    .post(`/api/admin/card-applications/${created.id}/revoke`)
    .set('Authorization', 'Bearer admin')
    .send({ reason: 'Ditemukan ketidaksesuaian data pendukung.', confirm: true })
    .expect(200);
  assert.equal(revokeRes.body.data.status, 'dicabut');
  assert.equal(revokeRes.body.data.issuedCard.state, 'revoked');
  assert.ok(revokeRes.body.data.issuedCard.revokedAt);

  // QR yang dicabut tidak lagi menampilkan status valid
  const revokedVerify = await request(app)
    .get(`/api/cards/verify/${issued.qrToken}`)
    .expect(200);
  assert.equal(revokedVerify.body.data.valid, false);
  assert.equal(revokedVerify.body.data.state, 'revoked');
  assert.equal(revokedVerify.body.data.holderName, null);
});

test('PBI-19 validasi & konsistensi: menolak input tidak valid, transisi ilegal, dan ID tidak ditemukan', async () => {
  const store = createInMemoryCardStore();
  const created = await seedApplication(store, USER_A, 'Rina Kusuma');
  const app = makeApp(store);

  // ID tidak valid (400) dan tidak ditemukan (404)
  await request(app)
    .get('/api/admin/card-applications/bukan-uuid')
    .set('Authorization', 'Bearer admin')
    .expect(400);
  await request(app)
    .get(`/api/admin/card-applications/${MISSING_ID}`)
    .set('Authorization', 'Bearer admin')
    .expect(404);

  // Tolak atau minta perbaikan wajib menyertakan alasan >= 5 karakter
  await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'rejected', reason: 'abc' })
    .expect(400);
  await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'perbaikan', reason: '' })
    .expect(400);

  // Tidak bisa perpanjang atau cabut sebelum verified
  await request(app)
    .post(`/api/admin/card-applications/${created.id}/renew`)
    .set('Authorization', 'Bearer admin')
    .send({ validityMonths: 12 })
    .expect(409);
  await request(app)
    .post(`/api/admin/card-applications/${created.id}/revoke`)
    .set('Authorization', 'Bearer admin')
    .send({ reason: 'Alasan cukup panjang', confirm: true })
    .expect(409);

  // Tolak pengajuan -> tidak bisa diubah lagi ke verified (transisi ilegal)
  await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'rejected', reason: 'Dokumen tidak terbaca dan bukan surat resmi.' })
    .expect(200);
  const illegal = await request(app)
    .post(`/api/admin/card-applications/${created.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'verified', reason: 'Coba paksa setujui.' })
    .expect(409);
  assert.equal(illegal.body.error.code, 'INVALID_STATUS_TRANSITION');
});

test('PBI-20: pencarian nama case-insensitive, filter status, empty state, dan riwayat peninjauan lengkap', async () => {
  const store = createInMemoryCardStore();
  const app1 = await seedApplication(store, USER_A, 'Hafiz Afra Riata');
  const app2 = await seedApplication(store, USER_B, 'Dewi Lestari');
  const app = makeApp(store);

  await request(app)
    .post(`/api/admin/card-applications/${app1.id}/decision`)
    .set('Authorization', 'Bearer admin')
    .send({ decision: 'verified', reason: 'Valid dan lengkap.' })
    .expect(200);

  // Pencarian case-insensitive berdasarkan nama
  const searchRes = await request(app)
    .get('/api/admin/card-applications?q=hafiz')
    .set('Authorization', 'Bearer admin')
    .expect(200);
  assert.equal(searchRes.body.data.total, 1);
  assert.equal(searchRes.body.data.items[0].id, app1.id);

  // Filter status
  const filterPending = await request(app)
    .get('/api/admin/card-applications?status=pending')
    .set('Authorization', 'Bearer admin')
    .expect(200);
  assert.equal(filterPending.body.data.total, 1);
  assert.equal(filterPending.body.data.items[0].id, app2.id);

  // Kombinasi pencarian + filter yang tidak cocok -> empty state
  const emptyRes = await request(app)
    .get('/api/admin/card-applications?q=hafiz&status=rejected')
    .set('Authorization', 'Bearer admin')
    .expect(200);
  assert.equal(emptyRes.body.data.total, 0);
  assert.deepEqual(emptyRes.body.data.items, []);

  // Detail menampilkan riwayat peninjauan (waktu, admin, perubahan status, catatan)
  const detailRes = await request(app)
    .get(`/api/admin/card-applications/${app1.id}`)
    .set('Authorization', 'Bearer admin')
    .expect(200);
  const history = detailRes.body.data.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].action, 'issued');
  assert.equal(history[0].actorId, ADMIN_ID);
  assert.equal(history[0].actorName, 'Admin Verifikator');
  assert.equal(history[0].actorRole, 'admin');
  assert.equal(history[0].previousStatus, 'pending');
  assert.equal(history[0].newStatus, 'verified');
  assert.equal(history[0].reason, 'Valid dan lengkap.');
  assert.ok(history[0].createdAt);
});
