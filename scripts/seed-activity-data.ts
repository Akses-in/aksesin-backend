import { getPrisma, disconnectDatabase } from '../src/lib/prisma.js';
import { ensureActivityTablesExist } from '../src/services/user-activity.js';

async function seed() {
  const db = getPrisma();
  console.log('Ensuring tables exist first...');
  await ensureActivityTablesExist();
  console.log('Seeding activity data...');

  const fauziahId = '06bb2efa-b393-4206-be29-ee0e8c1dcb4d';
  const otherUserId = '1dd52b56-30a9-4c9f-9ae6-5f2d9db0ea26';

  // 1. Places
  await db.$executeRaw`
    INSERT INTO public.places (id, name, category, address, latitude, longitude)
    VALUES 
      ('11111111-aaaa-4111-8111-111111111111'::uuid, 'Stasiun MRT Bundaran HI', 'Stasiun MRT', 'Jl. M.H. Thamrin, Menteng, Jakarta Pusat', -6.1925, 106.8228),
      ('22222222-bbbb-4222-8222-222222222222'::uuid, 'Halte Transjakarta Tosari', 'Halte Bus', 'Jl. Jenderal Sudirman, Menteng, Jakarta Pusat', -6.1978, 106.8219),
      ('33333333-cccc-4333-8333-333333333333'::uuid, 'Taman Suropati', 'Taman Publik', 'Jl. Taman Suropati No. 5, Menteng, Jakarta Pusat', -6.1994, 106.8326)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address`;

  // 2. Community Posts
  await db.$executeRaw`
    INSERT INTO public.community_posts (id, user_id, place_id, title, content)
    VALUES 
      ('44444444-dddd-4444-8444-444444444444'::uuid, ${fauziahId}::uuid, '11111111-aaaa-4111-8111-111111111111'::uuid, 
       'Aksesibilitas Stasiun MRT Bundaran HI untuk Pengguna Kursi Roda', 
       'Mari berbagi pengalaman dan informasi aksesibilitas di stasiun MRT Bundaran HI.'),
      ('55555555-eeee-4555-8555-555555555555'::uuid, ${otherUserId}::uuid, '22222222-bbbb-4222-8222-222222222222'::uuid, 
       'Kondisi Fasilitas Guiding Block di Halte Tosari', 
       'Bagaimana kondisi tactile paving di koridor jembatan halte Tosari?')
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content`;

  // 3. Comments (Fauziah's own comments)
  await db.$executeRaw`
    INSERT INTO public.community_comments (id, user_id, post_id, content, created_at)
    VALUES 
      ('66666666-ffff-4666-8666-666666666666'::uuid, ${fauziahId}::uuid, '44444444-dddd-4444-8444-444444444444'::uuid,
       'Ramp di pintu B sangat landai dan lebar, sangat memudahkan pengguna kursi roda serta orang tua dengan stroller.',
       now() - interval '2 hours'),
      ('77777777-ffff-4777-8777-777777777777'::uuid, ${fauziahId}::uuid, '55555555-eeee-4555-8555-555555555555'::uuid,
       'Guiding block kuning di jembatan penghubung sudah tersambung rapi sampai ke loket tap tiket.',
       now() - interval '1 day'),
      ('88888888-ffff-4888-8888-888888888888'::uuid, ${otherUserId}::uuid, '44444444-dddd-4444-8444-444444444444'::uuid,
       'Komentar milik pengguna lain yang tidak boleh terlihat oleh Fauziah.',
       now() - interval '3 hours')
    ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`;

  // 4. Accessibility Contributions (Fauziah's own place reviews)
  await db.$executeRaw`
    INSERT INTO public.accessibility_contributions (id, user_id, place_id, status, notes, submitted_at)
    VALUES 
      ('99999999-0000-4999-8999-999999999999'::uuid, ${fauziahId}::uuid, '22222222-bbbb-4222-8222-222222222222'::uuid,
       'approved',
       'Tersedia lift prioritas khusus lansia dan disabilitas yang berfungsi baik, petugas ramah membantu penyeberangan.',
       now() - interval '3 days'),
      ('aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa'::uuid, ${fauziahId}::uuid, '33333333-cccc-4333-8333-333333333333'::uuid,
       'pending',
       'Jalur pedestrian utama taman sudah rata dan ramah kursi roda, namun perlu penambahan ramp di sisi timur air mancur.',
       now() - interval '5 hours'),
      ('bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb'::uuid, ${otherUserId}::uuid, '11111111-aaaa-4111-8111-111111111111'::uuid,
       'approved',
       'Kontribusi review milik pengguna lain yang tidak boleh terlihat oleh Fauziah.',
       now() - interval '4 hours')
    ON CONFLICT (id) DO UPDATE SET notes = EXCLUDED.notes, status = EXCLUDED.status`;

  // 5. Saved Places for Fauziah
  await db.$executeRaw`
    INSERT INTO public.saved_places (id, user_id, place_id, created_at)
    VALUES 
      ('cccccccc-1111-4ccc-8ccc-cccccccccccc'::uuid, ${fauziahId}::uuid, '11111111-aaaa-4111-8111-111111111111'::uuid, now() - interval '2 days'),
      ('dddddddd-2222-4ddd-8ddd-dddddddddddd'::uuid, ${fauziahId}::uuid, '22222222-bbbb-4222-8222-222222222222'::uuid, now() - interval '1 day')
    ON CONFLICT (user_id, place_id) DO NOTHING`;

  console.log('Seeding completed successfully!');
  await disconnectDatabase();
}

void seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
