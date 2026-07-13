# apps/mobile — instructions

These rules extend the root CLAUDE.md; they never weaken it.

- Session material is stored ONLY via the SecureStore adapter in `lib/supabase.ts`
  (keychain/keystore). Never move tokens to AsyncStorage or files.
- Only EXPO_PUBLIC_* configuration may appear in this app; it ships in the bundle.
  No Stripe secret, no service-role key, no webhook secret — ever.
- The app talks to Supabase with the anon key (RLS enforced) and to services/api with the
  user's bearer token. Purchases are never confirmed client-side; show the order state the
  webhook wrote.
- Images are compressed/resized and EXIF-stripped on device (expo-image-manipulator)
  before upload per docs/MEDIA_PIPELINE.md.
- Long lists use FlatList (virtualized) with bounded page sizes; no unbounded fetches.
- Accessibility: labels on inputs/buttons, 44pt touch targets, dynamic-type friendly text.
- E2E flows live in `.maestro/`; keep the smoke flow green.
