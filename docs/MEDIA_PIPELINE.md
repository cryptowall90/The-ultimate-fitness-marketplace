# Media pipeline

## Client-side (before upload)

Mobile (expo-image-manipulator) and web: correct orientation, resize to the target
variant's max dimension, strip EXIF/GPS (re-encode drops metadata), compress to WebP where
supported (JPEG fallback), reject unsupported files early.

Variants & size targets (`@fitmarket/media` `IMAGE_VARIANTS`): avatar 64² (50–150 KB),
thumbnail 160², card ≤480 px (150–350 KB), detail ≤1080 px, private progress ≤1440 px
(250–600 KB). Default max post-compression upload: **1 MB** (PDF credentials: 10 MB).

## Server-side (services/api + storage provider)

```mermaid
sequenceDiagram
  participant C as Client app
  participant A as services/api
  participant S as Storage
  C->>A: request upload (auth, kind, declared type, size)
  A->>A: quota check, RANDOM object key, content-length cap
  A-->>C: one-time signed URL (short expiry)
  C->>S: PUT
  A->>S: read bytes -> sniffMime (magic bytes)
  A->>A: declared type MUST match signature; SVG rejected outright
  A->>A: dimension/pixel caps (image bombs), re-encode, generate variants
  A->>A: media_objects: pending_upload -> quarantined -> processing -> published
```

- Non-image files (PDF credentials) go through malware scanning before publish.
- User filenames are display metadata only — never paths (`generateObjectKey`).
- Public profile media: Cloudflare Images/CDN with versioned URLs, lazy loading, blur
  placeholders. Private media (progress photos, credentials, attachments): private buckets,
  authorization on every access, short-lived signed URLs, `media_access_logs` audit for
  sensitive reads; bulk downloads require authorization + audit (root rule).
- Abandoned `pending_upload` rows are deleted by a lifecycle job
  (`media_objects_abandoned_idx`); per-user quota from `system_settings`
  (`uploads.per_user_quota_bytes`).
- Provider abstraction (`MediaStorageProvider`) keeps Supabase Storage, R2 and Cloudflare
  Images swappable.

## Endpoints (services/api)

- `POST /v1/media/uploads` (bearer auth, rate-limited): validates kind/type/size, enforces
  the per-user quota and pending-upload cap, creates the `media_objects` row in
  `pending_upload` with a random object key, and returns a one-time signed upload URL.
- `POST /v1/media/uploads/:id/complete` (bearer auth, owner only): reads the object back
  from storage, verifies magic bytes against the declared type (mismatch → `rejected`,
  object deleted), records size + sha256 and moves the row to `quarantined`. The
  scan/re-encode/publish worker (quarantined → processing → published) is a separate
  server-managed step — clients can never publish.

Storage access uses `SupabaseStorageProvider` (`@fitmarket/media`), a fetch-based adapter
for the Supabase Storage REST API authenticated with the service-role key (services/api
only; fixed base URL from env — no user-controlled outbound URLs).

Validation logic + tests: `packages/media/src/validation.ts`,
`packages/media/test/validation.test.ts` (SVG/polyglot rejection is critical test 14).
