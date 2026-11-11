import { getPrisma, disconnectDatabase } from '../src/lib/prisma.js';

async function check() {
  try {
    const db = getPrisma();
    const users = await db.$queryRaw`SELECT id, email, phone, raw_user_meta_data FROM auth.users LIMIT 5`;
    console.log('USERS:', JSON.stringify(users, null, 2));

    const comments = await db.$queryRaw`SELECT count(*)::int as count FROM public.community_comments`;
    const contributions = await db.$queryRaw`SELECT count(*)::int as count FROM public.accessibility_contributions`;
    const places = await db.$queryRaw`SELECT count(*)::int as count FROM public.places`;
    const posts = await db.$queryRaw`SELECT count(*)::int as count FROM public.community_posts`;
    console.log('STATS:', { comments, contributions, places, posts });
  } catch (e) {
    console.error('Error:', e);
  } finally {
    await disconnectDatabase();
  }
}

void check();

