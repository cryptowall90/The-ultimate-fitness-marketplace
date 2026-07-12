-- 0003: media objects. One table backs avatars, credential documents, progress
-- photos, and message attachments. Storage provider is abstracted; object_key is
-- random (never user-supplied filenames).

create table public.media_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users (id) on delete cascade,
  provider text not null check (provider in ('supabase_storage', 'cloudflare_images', 'r2')),
  bucket text not null check (char_length(bucket) <= 100),
  object_key text not null check (object_key ~ '^[a-z0-9/_-]{8,200}$'),
  visibility public.media_visibility not null,
  status public.media_status not null default 'pending_upload',
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf')),
  byte_size int check (byte_size between 1 and 10485760),
  width int check (width between 1 and 8192),
  height int check (height between 1 and 8192),
  sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
  original_filename text check (char_length(original_filename) <= 255), -- display only, never a path
  variants jsonb not null default '{}'::jsonb, -- provider variant map snapshot
  quarantine_reason text,
  uploaded_at timestamptz,
  published_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, bucket, object_key)
);

create trigger media_objects_touch before update on public.media_objects
  for each row execute function app.touch_updated_at();

create index media_objects_owner_idx on public.media_objects (owner_id, visibility, status);
create index media_objects_abandoned_idx on public.media_objects (created_at)
  where status = 'pending_upload';

-- Wire up deferred FKs from 0002.
alter table public.profiles
  add constraint profiles_avatar_media_fk
  foreign key (avatar_media_id) references public.media_objects (id) on delete set null;

alter table public.trainer_credentials
  add constraint trainer_credentials_document_media_fk
  foreign key (document_media_id) references public.media_objects (id) on delete set null;

-- Sensitive-media access audit (bulk/private downloads).
create table public.media_access_logs (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media_objects (id) on delete cascade,
  accessed_by uuid not null references public.users (id) on delete cascade,
  purpose text not null check (char_length(purpose) <= 200),
  created_at timestamptz not null default now()
);

create index media_access_logs_media_idx on public.media_access_logs (media_id, created_at);

alter table public.media_objects enable row level security;
alter table public.media_access_logs enable row level security;

-- Owner sees own media rows. Signed URLs for private media are issued only by the
-- server after row-level authorization; other-party read policies are added where
-- the relationship tables exist (progress photos in 0010, attachments in 0008).
create policy media_objects_owner_select on public.media_objects
  for select using (owner_id = auth.uid());

-- Metadata for published public-profile media is readable (needed to render
-- public trainer profiles).
create policy media_objects_public_select on public.media_objects
  for select using (visibility = 'public_profile' and status = 'published');

-- Uploads are authorized server-side (signed upload flow) — inserts by the
-- owner are allowed only in pending state; the server flips status after scan.
create policy media_objects_owner_insert on public.media_objects
  for insert with check (owner_id = auth.uid() and status = 'pending_upload');

create policy media_objects_owner_delete_soft on public.media_objects
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function app.protect_media_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  -- Owners may only soft-delete; scan/publish transitions are server-managed.
  if new.status is distinct from old.status and new.status <> 'deleted' then
    raise exception 'media status is managed by the platform';
  end if;
  if new.object_key is distinct from old.object_key
     or new.provider is distinct from old.provider
     or new.bucket is distinct from old.bucket
     or new.visibility is distinct from old.visibility then
    raise exception 'media location fields are immutable';
  end if;
  return new;
end
$$;

create trigger media_objects_protect_status
  before update on public.media_objects
  for each row execute function app.protect_media_status();

create policy media_access_logs_owner_select on public.media_access_logs
  for select using (
    accessed_by = auth.uid()
    or exists (select 1 from public.media_objects m
               where m.id = media_access_logs.media_id and m.owner_id = auth.uid())
  );
