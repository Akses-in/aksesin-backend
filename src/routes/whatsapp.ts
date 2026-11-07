import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPrisma } from '../lib/prisma.js';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const password = z.string().min(8).max(72)
  .regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/)
  .refine((value) => Buffer.byteLength(value) <= 72);
const challenge = z.strictObject({ phone, challengeId: z.uuid() });

type ChallengeRow = {
  challenge_id: string;
  full_name: string;
  otp_hash: string;
  attempts: number;
  can_send: boolean;
  active: boolean;
  hourly_count: number;
};

export const whatsappRouter = Router();

whatsappRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function supabaseClients() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY) return null;

  const options = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  };
  return {
    admin: createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, options),
    auth: createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, options),
    otpKey: env.SUPABASE_SECRET_KEY,
  };
}

function challengeHash(key: string, purpose: 'otp' | 'registration', phoneNumber: string, challengeId: string, code: string) {
  return createHmac('sha256', key).update(`aksesin:${purpose}:${phoneNumber}:${challengeId}:${code}`).digest('hex');
}

async function issueOtp(phoneNumber: string, key: string, fonnteToken: string, input: { name: string } | { challengeId: string }) {
  const challengeId = 'challengeId' in input ? input.challengeId : randomUUID();
  const otp = randomInt(1_000_000).toString().padStart(6, '0');
  const digest = challengeHash(key, 'otp', phoneNumber, challengeId, otp);
  const db = getPrisma();

  const status = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(190846, 1)`;
    await tx.$executeRaw`DELETE FROM aksesin_private.whatsapp_challenges
      WHERE last_sent_at < now() - interval '1 day'`;
    const [previous] = await tx.$queryRaw<ChallengeRow[]>`
      SELECT challenge_id, full_name,
        last_sent_at <= now() - interval '1 minute' AS can_send,
        CASE WHEN window_started_at > now() - interval '1 hour' THEN sent_count ELSE 0 END AS hourly_count
      FROM aksesin_private.whatsapp_challenges WHERE phone = ${phoneNumber}`;
    const name = 'name' in input ? input.name : previous?.full_name;
    if (!name || ('challengeId' in input && previous?.challenge_id !== challengeId)) return 400;
    if (previous && (!previous.can_send || previous.hourly_count >= 5)) return 429;

    const [global] = await tx.$queryRaw<{ sends: number }[]>`
      SELECT coalesce(sum(sent_count), 0)::int AS sends
      FROM aksesin_private.whatsapp_challenges
      WHERE window_started_at > now() - interval '1 hour'`;
    if ((global?.sends ?? 0) >= 100) return 429;

    const count = (previous?.hourly_count ?? 0) + 1;
    await tx.$executeRaw`
      INSERT INTO aksesin_private.whatsapp_challenges
        (phone, challenge_id, full_name, otp_hash, expires_at, last_sent_at, window_started_at, sent_count)
      VALUES (${phoneNumber}, ${challengeId}::uuid, ${name}, ${digest}, now() + interval '5 minutes', now(), now(), 1)
      ON CONFLICT (phone) DO UPDATE SET challenge_id = excluded.challenge_id,
        full_name = excluded.full_name, otp_hash = excluded.otp_hash, expires_at = excluded.expires_at,
        last_sent_at = now(), attempts = 0, sent_count = ${count},
        window_started_at = CASE WHEN ${count} = 1 THEN now()
          ELSE aksesin_private.whatsapp_challenges.window_started_at END`;
    return 200;
  });
  if (status !== 200) return { status };

  const form = new FormData();
  form.set('target', phoneNumber.slice(1));
  form.set('countryCode', '0');
  form.set('message', `Kode verifikasi Aksesin: ${otp}. Jangan bagikan kode ini kepada siapa pun.`);
  try {
    const result = await fetch('https://api.fonnte.com/send', {
      method: 'POST', headers: { Authorization: fonnteToken }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (result.ok && (await result.json())?.status === true) return { status: 200, challengeId };
  } catch {
    // A timeout can occur after Fonnte accepts the message, so invalidate its code.
  }

  await db.$executeRaw`UPDATE aksesin_private.whatsapp_challenges SET expires_at = now()
    WHERE phone = ${phoneNumber} AND otp_hash = ${digest}`;
  return { status: 502 };
}

whatsappRouter.post('/start', async (req, res) => {
  const input = z.strictObject({ phone, name: z.string().trim().min(1).max(100) }).parse(req.body);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL || !env.FONNTE_TOKEN) return res.sendStatus(503);
  const result = await issueOtp(input.phone, clients.otpKey, env.FONNTE_TOKEN, { name: input.name });
  return res.status(result.status).json({ challengeId: result.challengeId });
});

whatsappRouter.post('/resend', async (req, res) => {
  const input = challenge.parse(req.body);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL || !env.FONNTE_TOKEN) return res.sendStatus(503);
  const result = await issueOtp(input.phone, clients.otpKey, env.FONNTE_TOKEN, { challengeId: input.challengeId });
  return res.status(result.status).json({ challengeId: result.challengeId });
});

whatsappRouter.post('/verify', async (req, res) => {
  const input = challenge.extend({ otp: z.string().regex(/^\d{6}$/) }).parse(req.body);
  if (!env.SUPABASE_SECRET_KEY || !env.DATABASE_URL) return res.sendStatus(503);

  const proof = randomBytes(32).toString('hex');
  const digest = challengeHash(env.SUPABASE_SECRET_KEY, 'otp', input.phone, input.challengeId, input.otp);
  const proofDigest = challengeHash(env.SUPABASE_SECRET_KEY, 'registration', input.phone, input.challengeId, proof);

  const verified = await getPrisma().$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<Pick<ChallengeRow, 'otp_hash' | 'attempts' | 'active'>[]>`
      SELECT otp_hash, attempts, expires_at > clock_timestamp() AS active
      FROM aksesin_private.whatsapp_challenges WHERE phone = ${input.phone}
        AND challenge_id = ${input.challengeId}::uuid FOR UPDATE`;
    if (!pending?.active || pending.attempts >= 5) return false;

    const match = timingSafeEqual(Buffer.from(pending.otp_hash, 'hex'), Buffer.from(digest, 'hex'));
    // Replace the OTP digest with a one-time proof for the password step.
    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges
      SET attempts = CASE WHEN ${match} THEN 5 ELSE attempts + 1 END,
        otp_hash = CASE WHEN ${match} THEN ${proofDigest} ELSE otp_hash END,
        expires_at = CASE WHEN ${match} THEN now() + interval '10 minutes' ELSE expires_at END
      WHERE phone = ${input.phone}`;
    return match;
  });
  if (!verified) return res.sendStatus(400);
  return res.json({ proof });
});

whatsappRouter.post('/complete', async (req, res) => {
  const input = challenge.extend({ proof: z.string().regex(/^[a-f0-9]{64}$/), password }).parse(req.body);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL) return res.sendStatus(503);

  const digest = challengeHash(clients.otpKey, 'registration', input.phone, input.challengeId, input.proof);
  const email = `${randomUUID()}@accounts.aksesin.invalid`;
  const status = await getPrisma().$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<{ full_name: string }[]>`
      SELECT full_name FROM aksesin_private.whatsapp_challenges
      WHERE phone = ${input.phone} AND challenge_id = ${input.challengeId}::uuid
        AND otp_hash = ${digest} AND expires_at > clock_timestamp() FOR UPDATE`;
    if (!pending) return 400;

    const { error } = await clients.admin.auth.admin.createUser({
      email, email_confirm: true, phone: input.phone, phone_confirm: true,
      password: input.password, user_metadata: { full_name: pending.full_name },
      app_metadata: { aksesin_login: 'whatsapp' },
    });
    const duplicate = error?.code === 'phone_exists' || error?.code === 'user_already_exists';
    if (error && !duplicate) return error.code === 'weak_password' ? 422 : 502;

    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges SET expires_at = now()
      WHERE phone = ${input.phone}`;
    return duplicate ? 409 : 200;
  }, { timeout: 8000 });
  if (status !== 200) return res.sendStatus(status);

  const { data } = await clients.auth.auth.signInWithPassword({ email, password: input.password });
  if (!data.session) return res.sendStatus(204);
  return res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});

whatsappRouter.post('/login', async (req, res) => {
  const input = z.strictObject({ phone, password: z.string().min(1).max(256) }).parse(req.body);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL) return res.sendStatus(503);

  const [account] = await getPrisma().$queryRaw<{ email: string }[]>`
    SELECT email FROM auth.users WHERE phone = ${input.phone.slice(1)}
      AND phone_confirmed_at IS NOT NULL AND raw_app_meta_data ->> 'aksesin_login' = 'whatsapp'`;
  const { data, error } = await clients.auth.auth.signInWithPassword(account
    ? { email: account.email, password: input.password }
    : input);
  if (error?.status === 429) return res.sendStatus(429);
  if (!data.session || !data.user?.phone_confirmed_at) return res.sendStatus(401);
  return res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});
