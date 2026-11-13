import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getPrisma } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const password = z.string().min(8).max(72)
  .regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/)
  .refine((value) => Buffer.byteLength(value) <= 72);
const challenge = z.strictObject({ phone, challengeId: z.uuid() });

type ChallengeRow = {
  challenge_id: string;
  full_name: string | null;
  account_id: string | null;
  purpose: ChallengePurpose;
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

function challengeHash(key: string, purpose: 'otp' | 'registration' | 'login', phoneNumber: string, challengeId: string, code: string) {
  return createHmac('sha256', key).update(`aksesin:${purpose}:${phoneNumber}:${challengeId}:${code}`).digest('hex');
}

type ChallengePurpose = 'registration' | 'phone_change' | 'login';
type OtpRequest = ({ name: string | null } | { challengeId: string }) & (
  { purpose?: 'registration'; accountId?: never } |
  { purpose: 'phone_change' | 'login'; accountId: string }
);

async function lockPhoneChanges(tx: Prisma.TransactionClient, accountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(190847, hashtext(${accountId}))`;
}

async function issueOtp(phoneNumber: string, key: string, fonnteToken: string, input: OtpRequest) {
  const accountId = input.accountId ?? null;
  const purpose = input.purpose ?? 'registration';
  const challengeId = 'challengeId' in input ? input.challengeId : randomUUID();
  const otp = randomInt(1_000_000).toString().padStart(6, '0');
  const digest = challengeHash(key, purpose === 'login' ? 'login' : 'otp', phoneNumber, challengeId, otp);
  const db = getPrisma();

  const status = await db.$transaction(async (tx) => {
    if (accountId) await lockPhoneChanges(tx, accountId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(190846, 1)`;
    if (purpose === 'registration') {
      const [existing] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM auth.users WHERE phone = ${phoneNumber.slice(1)} AND phone_confirmed_at IS NOT NULL`;
      if (existing) return 409;
    }
    await tx.$executeRaw`DELETE FROM aksesin_private.whatsapp_challenges
      WHERE last_sent_at < now() - interval '1 day'`;
    const [previous] = await tx.$queryRaw<ChallengeRow[]>`
      SELECT challenge_id, full_name, account_id, purpose, expires_at > now() AS active,
        last_sent_at <= now() - interval '1 minute' AS can_send,
        CASE WHEN window_started_at > now() - interval '1 hour' THEN sent_count ELSE 0 END AS hourly_count
      FROM aksesin_private.whatsapp_challenges WHERE phone = ${phoneNumber} FOR UPDATE`;
    if ('challengeId' in input && (previous?.challenge_id !== challengeId ||
      previous.account_id !== accountId || previous.purpose !== purpose)) return 400;
    if (previous?.active && (previous.account_id !== accountId || previous.purpose !== purpose)) return 429;
    const name = 'name' in input ? input.name : previous?.full_name ?? null;
    if (previous && (!previous.can_send || previous.hourly_count >= 5)) return 429;

    const [global] = await tx.$queryRaw<{ sends: number }[]>`
      SELECT coalesce(sum(sent_count), 0)::int AS sends
      FROM aksesin_private.whatsapp_challenges
      WHERE window_started_at > now() - interval '1 hour'`;
    if ((global?.sends ?? 0) >= 100) return 429;

    if (purpose === 'phone_change') {
      await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges
        SET expires_at = now(), attempts = 5, challenge_id = gen_random_uuid()
        WHERE account_id = ${accountId}::uuid AND purpose = 'phone_change' AND phone <> ${phoneNumber}`;
    }
    const count = (previous?.hourly_count ?? 0) + 1;
    await tx.$executeRaw`
      INSERT INTO aksesin_private.whatsapp_challenges
        (phone, challenge_id, full_name, account_id, purpose, otp_hash, expires_at, last_sent_at, window_started_at, sent_count)
      VALUES (${phoneNumber}, ${challengeId}::uuid, ${name}, ${accountId}::uuid, ${purpose},
        ${digest}, now() + interval '5 minutes', now(), now(), 1)
      ON CONFLICT (phone) DO UPDATE SET challenge_id = excluded.challenge_id, account_id = excluded.account_id,
        full_name = excluded.full_name, purpose = excluded.purpose, otp_hash = excluded.otp_hash, expires_at = excluded.expires_at,
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

async function checkOtp(tx: Prisma.TransactionClient, input: z.infer<typeof challenge>, digest: string, purpose: ChallengePurpose, accountId: string | null) {
  const [pending] = await tx.$queryRaw<Pick<ChallengeRow, 'otp_hash' | 'attempts' | 'active'>[]>`
    SELECT otp_hash, attempts, expires_at > clock_timestamp() AS active
    FROM aksesin_private.whatsapp_challenges WHERE phone = ${input.phone}
      AND challenge_id = ${input.challengeId}::uuid
      AND purpose = ${purpose}
      AND account_id IS NOT DISTINCT FROM ${accountId}::uuid FOR UPDATE`;
  if (!pending?.active || pending.attempts >= 5) return false;
  if (timingSafeEqual(Buffer.from(pending.otp_hash, 'hex'), Buffer.from(digest, 'hex'))) return true;

  await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges
    SET attempts = attempts + 1 WHERE phone = ${input.phone}`;
  return false;
}

const otpChallenge = challenge.extend({ otp: z.string().regex(/^\d{6}$/) });

whatsappRouter.post('/verify', async (req, res) => {
  const input = otpChallenge.parse(req.body);
  if (!env.SUPABASE_SECRET_KEY || !env.DATABASE_URL) return res.sendStatus(503);

  const proof = randomBytes(32).toString('hex');
  const digest = challengeHash(env.SUPABASE_SECRET_KEY, 'otp', input.phone, input.challengeId, input.otp);
  const proofDigest = challengeHash(env.SUPABASE_SECRET_KEY, 'registration', input.phone, input.challengeId, proof);

  const verified = await getPrisma().$transaction(async (tx) => {
    if (!await checkOtp(tx, input, digest, 'registration', null)) return false;
    // Replace the OTP digest with a one-time proof for account creation.
    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges
      SET attempts = 5, otp_hash = ${proofDigest}, expires_at = now() + interval '10 minutes'
      WHERE phone = ${input.phone}`;
    return true;
  });
  if (!verified) return res.sendStatus(400);
  return res.json({ proof });
});

whatsappRouter.post('/complete', async (req, res) => {
  const input = challenge.extend({ proof: z.string().regex(/^[a-f0-9]{64}$/), password: password.optional() }).parse(req.body);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL) return res.sendStatus(503);

  const digest = challengeHash(clients.otpKey, 'registration', input.phone, input.challengeId, input.proof);
  const email = `${randomUUID()}@accounts.aksesin.invalid`;
  const accountPassword = input.password ?? `Aa1!${randomBytes(32).toString('base64url')}`;
  const status = await getPrisma().$transaction(async (tx) => {
    const [pending] = await tx.$queryRaw<{ full_name: string }[]>`
      SELECT full_name FROM aksesin_private.whatsapp_challenges
      WHERE phone = ${input.phone} AND challenge_id = ${input.challengeId}::uuid
        AND account_id IS NULL AND otp_hash = ${digest} AND expires_at > clock_timestamp() FOR UPDATE`;
    if (!pending) return 400;

    const { error } = await clients.admin.auth.admin.createUser({
      email, email_confirm: true, phone: input.phone, phone_confirm: true,
      password: accountPassword, user_metadata: { full_name: pending.full_name },
      app_metadata: { aksesin_login: 'whatsapp' },
    });
    const duplicate = error?.code === 'phone_exists' || error?.code === 'user_already_exists';
    if (error && !duplicate) return error.code === 'weak_password' ? 422 : 502;

    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges SET expires_at = now()
      WHERE phone = ${input.phone}`;
    return duplicate ? 409 : 200;
  }, { timeout: 8000 });
  if (status !== 200) return res.sendStatus(status);

  const { data } = await clients.auth.auth.signInWithPassword({ email, password: accountPassword });
  if (!data.session) return res.sendStatus(204);
  return res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});

whatsappRouter.post('/change/:action', async (req, res) => {
  const action = z.enum(['start', 'resend', 'verify']).safeParse(req.params.action);
  if (!action.success) return res.sendStatus(404);
  const accessToken = req.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!accessToken) return res.sendStatus(401);
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL || !env.FONNTE_TOKEN) return res.sendStatus(503);

  const { data: { user }, error } = await clients.auth.auth.getUser(accessToken);
  if (error?.status && error.status >= 500) return res.sendStatus(502);
  if (!user?.email_confirmed_at && !user?.phone_confirmed_at) return res.sendStatus(401);
  const accountId = user.id;

  if (action.data === 'start') {
    const input = z.strictObject({ phone }).parse(req.body);
    if (user.phone_confirmed_at && input.phone.slice(1) === user.phone?.replace(/^\+/, '')) {
      return res.sendStatus(422);
    }
    const result = await issueOtp(input.phone, clients.otpKey, env.FONNTE_TOKEN, { name: null, accountId, purpose: 'phone_change' });
    return res.status(result.status).json({ challengeId: result.challengeId });
  }

  if (action.data === 'resend') {
    const input = challenge.parse(req.body);
    const result = await issueOtp(input.phone, clients.otpKey, env.FONNTE_TOKEN, { challengeId: input.challengeId, accountId, purpose: 'phone_change' });
    return res.status(result.status).json({ challengeId: result.challengeId });
  }

  const input = otpChallenge.parse(req.body);
  const digest = challengeHash(clients.otpKey, 'otp', input.phone, input.challengeId, input.otp);
  const status = await getPrisma().$transaction(async (tx) => {
    await lockPhoneChanges(tx, accountId);
    if (!await checkOtp(tx, input, digest, 'phone_change', accountId)) return 400;

    const { error: updateError } = await clients.admin.auth.admin.updateUserById(accountId, {
      phone: input.phone,
      phone_confirm: true,
      ...(user.email_confirmed_at && user.email ? { app_metadata: { aksesin_login: 'whatsapp' } } : {}),
    });
    const duplicate = updateError?.code === 'phone_exists' || updateError?.code === 'user_already_exists';
    if (updateError && !duplicate) return 502;

    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges
      SET expires_at = now(), attempts = 5, challenge_id = gen_random_uuid()
      WHERE phone = ${input.phone}`;
    return duplicate ? 409 : 204;
  }, { timeout: 8000 });

  return res.sendStatus(status);
});

whatsappRouter.post('/login/:action', async (req, res) => {
  const action = z.enum(['start', 'resend', 'verify']).safeParse(req.params.action);
  if (!action.success) return res.sendStatus(404);
  const input = action.data === 'start' ? { action: 'start' as const, ...z.strictObject({ phone }).parse(req.body) }
    : action.data === 'resend' ? { action: 'resend' as const, ...challenge.parse(req.body) }
    : { action: 'verify' as const, ...otpChallenge.parse(req.body) };
  const clients = supabaseClients();
  if (!clients || !env.DATABASE_URL || !env.FONNTE_TOKEN) return res.sendStatus(503);

  const db = getPrisma();
  const [account] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM auth.users WHERE phone = ${input.phone.slice(1)}
      AND phone_confirmed_at IS NOT NULL AND email_confirmed_at IS NOT NULL AND email IS NOT NULL`;
  if (!account) return res.sendStatus(input.action === 'start' ? 404 : 400);

  if (input.action !== 'verify') {
    const request = input.action === 'resend' ? { challengeId: input.challengeId } : { name: null };
    const result = await issueOtp(input.phone, clients.otpKey, env.FONNTE_TOKEN,
      { ...request, accountId: account.id, purpose: 'login' });
    return res.status(result.status).json({ challengeId: result.challengeId });
  }

  const digest = challengeHash(clients.otpKey, 'login', input.phone, input.challengeId, input.otp);
  const result = await db.$transaction(async (tx) => {
    await lockPhoneChanges(tx, account.id);
    if (!await checkOtp(tx, input, digest, 'login', account.id)) return { status: 400 };

    const [current] = await tx.$queryRaw<{ email: string }[]>`
      SELECT email FROM auth.users WHERE id = ${account.id}::uuid AND phone = ${input.phone.slice(1)}
        AND phone_confirmed_at IS NOT NULL AND email_confirmed_at IS NOT NULL AND email IS NOT NULL`;
    if (!current) return { status: 400 };

    // Exchange a server-only magic link for a Supabase session without sending email.
    const { data: link, error } = await clients.admin.auth.admin.generateLink({ type: 'magiclink', email: current.email });
    if (error || link.user.id !== account.id) return { status: error?.status === 429 ? 429 : 502 };
    const { data, error: verifyError } = await clients.auth.auth.verifyOtp({
      token_hash: link.properties.hashed_token, type: 'email',
    });
    if (!data.session || data.user?.id !== account.id) return { status: verifyError?.status === 429 ? 429 : 502 };

    await tx.$executeRaw`UPDATE aksesin_private.whatsapp_challenges SET expires_at = now(), attempts = 5
      WHERE phone = ${input.phone}`;
    return { status: 200, tokens: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } };
  }, { timeout: 13000 });

  return result.tokens ? res.json(result.tokens) : res.sendStatus(result.status);
});
