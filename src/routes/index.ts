import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPrisma } from '../lib/prisma.js';
import { whatsappRouter } from './whatsapp.js';

export const router = Router();

router.use('/api/auth/whatsapp', whatsappRouter);

router.get('/', (_req, res) => {
  res.json({ name: 'aksesin-backend', status: 'ok' });
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

router.get('/health/db', async (_req, res) => {
  if (!env.DATABASE_URL) {
    res.status(503).json({ status: 'unavailable', database: 'not_configured' });
    return;
  }

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'unreachable' });
  }
});

const echoSchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
});

router.post('/api/echo', (req, res) => {
  const input = echoSchema.parse(req.body);
  res.json({ data: input });
});
