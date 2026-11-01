import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';

test('health responds without depending on the database', async () => {
  const response = await request(app).get('/health').expect(200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.ok(response.headers['x-content-type-options']);
});

test('Zod trims valid input', async () => {
  const response = await request(app).post('/api/echo').send({ message: ' Halo ' }).expect(200);
  assert.deepEqual(response.body, { data: { message: 'Halo' } });
});

test('Zod rejects missing, empty, oversized, and unexpected fields', async () => {
  for (const body of [{}, { message: '   ' }, { message: 'a'.repeat(501) }, { message: 'Halo', admin: true }]) {
    const response = await request(app).post('/api/echo').send(body).expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  }
});

test('malformed JSON returns a safe response', async () => {
  const response = await request(app).post('/api/echo')
    .set('Content-Type', 'application/json').send('{invalid').expect(400);
  assert.equal(response.body.error.code, 'BAD_REQUEST');
  assert.equal(response.body.error.stack, undefined);
});

test('oversized payload is rejected', async () => {
  const response = await request(app).post('/api/echo')
    .send({ message: 'a'.repeat(110000) }).expect(413);
  assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('unknown routes return JSON 404', async () => {
  const response = await request(app).get('/missing').expect(404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
});

test('database readiness reports missing configuration', { skip: Boolean(env.DATABASE_URL) }, async () => {
  const response = await request(app).get('/health/db').expect(503);
  assert.equal(response.body.database, 'not_configured');
});

test('CORS permits the configured frontend origin', async () => {
  const origin = env.CORS_ORIGINS[0];
  if (!origin) return;
  const response = await request(app).get('/health').set('Origin', origin).expect(200);
  assert.equal(response.headers['access-control-allow-origin'], origin);
});

test('CORS does not grant access to an unlisted origin', async () => {
  const response = await request(app).get('/health').set('Origin', 'https://unlisted.invalid').expect(200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});
