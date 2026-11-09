import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createCardApplicationsRouter } from '../src/routes/card-applications.js';
import {
  CARD_STATUS_METADATA,
  CardDomainError,
  canCancelCardApplication,
  canEditCardApplication,
  createCardApplicationSchema,
  createInMemoryCardStore,
  statusTransitionSchema,
  updateCardApplicationSchema,
} from '../src/services/card-application.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

const validDocument = {
  documentType: 'surat_keterangan' as const,
  fileName: 'surat-keterangan-disabilitas.pdf',
  mimeType: 'application/pdf' as const,
  fileSize: Buffer.byteLength('PDF-1.4-mock-supporting-document'),
  contentBase64: Buffer.from('PDF-1.4-mock-supporting-document').toString('base64'),
};

const validApplicationInput = {
  fullName: 'Hafiz Afra Riata',
  disabilityCategory: 'fisik' as const,
  needs: ['step_free', 'priority_seating'] as const,
  notes: 'Membutuhkan akses ramp kursi roda dan lift prioritas.',
  consentGiven: true,
  document: validDocument,
};

test('PBI-17: menolak pengajuan jika persetujuan (consent) tidak dicentang atau input tidak valid', () => {
  const withoutConsent = createCardApplicationSchema.safeParse({
    ...validApplicationInput,
    consentGiven: false,
  });
  assert.equal(withoutConsent.success, false);
  assert.ok(
    withoutConsent.error.issues.some((i) => i.path.includes('consentGiven')),
    'Harus menolak pengajuan tanpa persetujuan penggunaan data',
  );

  const invalidMime = createCardApplicationSchema.safeParse({
    ...validApplicationInput,
    document: {
      ...validDocument,
      mimeType: 'application/x-msdownload',
    },
  });
  assert.equal(invalidMime.success, false);

  const oversizedFile = createCardApplicationSchema.safeParse({
    ...validApplicationInput,
    document: {
      ...validDocument,
      fileSize: 6 * 1024 * 1024, // 6 MB > 5 MB limit
    },
  });
  assert.equal(oversizedFile.success, false);

  const shortName = createCardApplicationSchema.safeParse({
    ...validApplicationInput,
    fullName: 'A',
  });
  assert.equal(shortName.success, false);
});

test('PBI-17: membuat pengajuan baru, menyimpan dokumen pendukung, dan menolak pengajuan ganda aktif', async () => {
  const store = createInMemoryCardStore();
  const parsed = createCardApplicationSchema.parse(validApplicationInput);

  const { application, notification } = await store.create(USER_A, parsed);
  assert.equal(application.userId, USER_A);
  assert.equal(application.status, 'pending');
  assert.equal(application.statusLabel, 'Menunggu peninjauan');
  assert.equal(application.canEdit, true);
  assert.equal(application.canCancel, true);
  assert.ok(application.evidence);
  assert.equal(application.evidence.fileName, 'surat-keterangan-disabilitas.pdf');
  assert.equal(notification.status, 'pending');
  assert.equal(notification.deepLink, `/kartu-aksesibilitas#pengajuan-${application.id}`);

  // Reject duplicate active application for the same user
  await assert.rejects(
    () => store.create(USER_A, parsed),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 409 &&
      err.code === 'ACTIVE_APPLICATION_EXISTS',
  );
});

test('PBI-17: otorisasi hanya mengizinkan pemilik mengakses, mengedit, dan membatalkan pengajuannya sendiri', async () => {
  const store = createInMemoryCardStore();
  const parsed = createCardApplicationSchema.parse(validApplicationInput);
  const { application } = await store.create(USER_A, parsed);

  // User B cannot see User A's cards in listByUser
  const userBCards = await store.listByUser(USER_B);
  assert.equal(userBCards.length, 0);

  // User B cannot update User A's application
  const updateInput = updateCardApplicationSchema.parse({
    notes: 'Diubah oleh pihak tidak berhak',
    consentGiven: true,
  });
  await assert.rejects(
    () => store.update(USER_B, application.id, updateInput),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 403 &&
      err.code === 'FORBIDDEN_ACCESS',
  );

  // User B cannot cancel User A's application
  await assert.rejects(
    () => store.cancel(USER_B, application.id),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 403 &&
      err.code === 'FORBIDDEN_ACCESS',
  );
});

test('PBI-17: pengajuan dapat diedit saat pending atau perbaikan, tetapi ditolak saat diproses atau verified', async () => {
  const store = createInMemoryCardStore();
  const parsed = createCardApplicationSchema.parse(validApplicationInput);
  const { application } = await store.create(USER_A, parsed);

  // Edit while pending succeeds
  const updatedPending = await store.update(
    USER_A,
    application.id,
    updateCardApplicationSchema.parse({
      notes: 'Catatan diperbarui sebelum ditinjau.',
      consentGiven: true,
    }),
  );
  assert.equal(updatedPending.application.notes, 'Catatan diperbarui sebelum ditinjau.');
  assert.equal(updatedPending.application.status, 'pending');

  // Move to diproses -> editing must be blocked
  await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'diproses', reason: 'Sedang diperiksa admin.' }),
  );
  assert.equal(canEditCardApplication('diproses'), false);
  assert.equal(canCancelCardApplication('diproses'), true);

  await assert.rejects(
    () =>
      store.update(
        USER_A,
        application.id,
        updateCardApplicationSchema.parse({
          notes: 'Coba edit saat sedang diproses',
          consentGiven: true,
        }),
      ),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 409 &&
      err.code === 'STATUS_NOT_EDITABLE',
  );

  // Move to perbaikan -> user can re-upload document and status returns to pending
  await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({
      status: 'perbaikan',
      reason: 'Foto surat keterangan kurang jelas, mohon unggah ulang.',
    }),
  );
  assert.equal(canEditCardApplication('perbaikan'), true);

  const revised = await store.update(
    USER_A,
    application.id,
    updateCardApplicationSchema.parse({
      consentGiven: true,
      document: {
        ...validDocument,
        fileName: 'surat-keterangan-revisi-jelas.pdf',
      },
    }),
  );
  assert.equal(revised.application.status, 'pending');
  assert.equal(revised.application.evidence?.fileName, 'surat-keterangan-revisi-jelas.pdf');
  assert.ok(revised.notification);

  // Move to verified -> neither edit nor cancel is allowed
  await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({
      status: 'verified',
      reason: 'Dokumen lengkap dan valid.',
    }),
  );
  assert.equal(canEditCardApplication('verified'), false);
  assert.equal(canCancelCardApplication('verified'), false);

  await assert.rejects(
    () => store.cancel(USER_A, application.id),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 409 &&
      err.code === 'STATUS_NOT_CANCELLABLE',
  );
});

test('PBI-17: pembatalan pengajuan menarik dokumen pendukung dan mengizinkan pengajuan ulang', async () => {
  const store = createInMemoryCardStore();
  const parsed = createCardApplicationSchema.parse(validApplicationInput);
  const { application } = await store.create(USER_A, parsed);

  const cancelled = await store.cancel(USER_A, application.id);
  assert.equal(cancelled.application.status, 'dibatalkan');
  assert.equal(cancelled.application.evidence, null);
  assert.ok(cancelled.application.cancelledAt);
  assert.equal(cancelled.notification.status, 'dibatalkan');

  // Cannot cancel an already cancelled application
  await assert.rejects(
    () => store.cancel(USER_A, application.id),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 409 &&
      err.code === 'STATUS_NOT_CANCELLABLE',
  );

  // User can submit a fresh application after previous one was cancelled
  const { application: secondApp } = await store.create(USER_A, parsed);
  assert.equal(secondApp.status, 'pending');
  assert.notEqual(secondApp.id, application.id);
});

test('PBI-18: perubahan status memicu notifikasi berurutan, mencegah duplikasi (idempotent), dan mematuhi hak akses', async () => {
  const store = createInMemoryCardStore();
  const parsed = createCardApplicationSchema.parse(validApplicationInput);
  const { application } = await store.create(USER_A, parsed);

  // 1. pending -> diproses
  const step1 = await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'diproses', reason: 'Pemeriksaan tahap awal.' }),
  );
  assert.equal(step1.idempotent, false);
  assert.ok(step1.notification);
  assert.equal(step1.notification.status, 'diproses');
  assert.equal(step1.notification.statusLabel, CARD_STATUS_METADATA.diproses.label);

  // Duplicate call with identical status and reason -> idempotent, no duplicate notification created
  const duplicateStep1 = await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'diproses', reason: 'Pemeriksaan tahap awal.' }),
  );
  assert.equal(duplicateStep1.idempotent, true);
  assert.equal(duplicateStep1.notification, null);

  // 2. diproses -> perbaikan
  const step2 = await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'perbaikan', reason: 'Mohon lampirkan halaman kedua surat.' }),
  );
  assert.equal(step2.idempotent, false);
  assert.equal(step2.notification?.status, 'perbaikan');

  // 3. perbaikan -> verified
  const step3 = await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'verified', reason: 'Verifikasi disetujui.' }),
  );
  assert.equal(step3.idempotent, false);
  assert.equal(step3.notification?.status, 'verified');

  // 4. verified -> dicabut
  const step4 = await store.transitionStatus(
    ADMIN_ID,
    application.id,
    statusTransitionSchema.parse({ status: 'dicabut', reason: 'Masa berlaku dokumen pendukung habis.' }),
  );
  assert.equal(step4.idempotent, false);
  assert.equal(step4.notification?.status, 'dicabut');

  // Verify User A received exactly 5 notifications (initial pending + 4 distinct transitions)
  const userANotifications = await store.listNotifications(USER_A);
  assert.equal(userANotifications.length, 5);
  assert.ok(userANotifications.every((n) => n.userId === USER_A));
  assert.ok(
    userANotifications.every((n) => n.deepLink === `/kartu-aksesibilitas#pengajuan-${application.id}`),
  );

  // User B receives 0 notifications
  const userBNotifications = await store.listNotifications(USER_B);
  assert.equal(userBNotifications.length, 0);

  // User B cannot mark User A's notification as read
  const firstNotifId = userANotifications[0]!.id;
  await assert.rejects(
    () => store.markNotificationRead(USER_B, firstNotifId),
    (err: unknown) =>
      err instanceof CardDomainError &&
      err.status === 403 &&
      err.code === 'FORBIDDEN_ACCESS',
  );

  // User A marks one notification and then all notifications as read
  const readOne = await store.markNotificationRead(USER_A, firstNotifId);
  assert.equal(readOne.isRead, true);
  assert.ok(readOne.readAt);

  const remainingUpdated = await store.markAllNotificationsRead(USER_A);
  assert.equal(remainingUpdated, 4);
});


test('menerima tiga dokumen campuran dan menolak dokumen keempat', async () => {
  const { document, ...application } = validApplicationInput;
  const image = Buffer.from('mock-image');
  const png = {
    ...document,
    fileName: 'bukti.png',
    mimeType: 'image/png',
    fileSize: image.length,
    contentBase64: image.toString('base64'),
  };
  const documents = [document, png, { ...document, fileName: 'lampiran.pdf' }];

  const input = createCardApplicationSchema.parse({ ...application, documents });
  const store = createInMemoryCardStore();
  const created = await store.create(USER_A, input);
  assert.deepEqual(
    created.application.documents.map((item) => item.fileName),
    documents.map((item) => item.fileName),
  );
  assert.equal(createCardApplicationSchema.safeParse({
    ...application,
    documents: [...documents, document],
  }).success, false);
  assert.equal(updateCardApplicationSchema.safeParse({
    consentGiven: true,
    documents: [...documents, document],
  }).success, false);
  assert.equal(createCardApplicationSchema.safeParse({
    ...application,
    documents: [{ ...document, fileSize: document.fileSize + 1 }],
  }).success, false);
});


test('pratinjau dokumen hanya dapat dibuka pemilik pengajuan', async () => {
  const store = createInMemoryCardStore();
  const input = createCardApplicationSchema.parse(validApplicationInput);
  const { application } = await store.create(USER_A, input);
  const documentId = application.documents[0]!.id;
  const path = `/card-applications/${application.id}/documents/${documentId}`;

  const app = express();
  app.use(createCardApplicationsRouter({
    store,
    authResolver: async (req) => {
      const id = req.get('Authorization');
      return id ? { id, role: 'user' } : null;
    },
  }));

  await request(app).get(path).expect(401);
  await request(app).get(path).set('Authorization', USER_B).expect(404);
  const response = await request(app).get(path).set('Authorization', USER_A)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
      res.on('error', done);
    })
    .expect('Content-Type', 'application/pdf')
    .expect('Content-Disposition', 'inline')
    .expect('Cache-Control', 'private, no-store')
    .expect(200);
  assert.deepEqual(response.body, Buffer.from(validDocument.contentBase64, 'base64'));

  await store.cancel(USER_A, application.id);
  await request(app).get(path).set('Authorization', USER_A).expect(404);
});
