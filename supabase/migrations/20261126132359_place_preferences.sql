alter table public.accessibility_preferences
  drop constraint accessibility_preferences_needs_check,
  add constraint accessibility_preferences_needs_check check (
    cardinality(needs) <= 12 and array_position(needs, null) is null and
    needs <@ array['step_free', 'priority_seating', 'audio', 'visual', 'companion', 'other',
      'wheelchair', 'toilets:wheelchair', 'ramp', 'elevator', 'tactile_paving', 'capacity:disabled']::text[]
  ),
  add column place_categories text[] not null default '{}' check (
    cardinality(place_categories) <= 9 and array_position(place_categories, null) is null and
    place_categories <@ array['Pendidikan', 'Kesehatan', 'Transportasi', 'Perbelanjaan', 'Taman',
      'Layanan Publik', 'Wisata dan Budaya', 'Tempat Ibadah', 'Lainnya']::text[]
  );
