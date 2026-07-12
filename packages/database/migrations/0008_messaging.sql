-- 0008: messaging — one conversation per enrollment, entitlement-gated writes,
-- receipts, attachments, blocking.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid unique references public.enrollments (id) on delete cascade,
  kind text not null default 'enrollment' check (kind in ('enrollment', 'inquiry', 'support')),
  client_id uuid not null references public.users (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  status public.conversation_status not null default 'active',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint enrollment_kind check (kind <> 'enrollment' or enrollment_id is not null)
);

create trigger conversations_touch before update on public.conversations
  for each row execute function app.touch_updated_at();

create index conversations_client_idx on public.conversations (client_id, last_message_at desc);
create index conversations_trainer_idx on public.conversations (trainer_id, last_message_at desc);

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null check (role in ('client', 'trainer', 'moderator')),
  archived_at timestamptz,
  notifications_muted boolean not null default false,
  -- moderator rows require an audited escalation
  escalation_case_id uuid,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_participants_user_idx on public.conversation_participants (user_id);

create or replace function app.is_conversation_participant(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation and cp.user_id = auth.uid()
  )
$$;

-- Can the current user send an ordinary message in this conversation right now?
create or replace function app.can_message(p_conversation uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  conv public.conversations;
begin
  select * into conv from public.conversations where id = p_conversation;
  if conv is null then return false; end if;
  if conv.status <> 'active' then return false; end if;
  if not app.is_conversation_participant(p_conversation) then return false; end if;
  if exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = conv.client_id and b.blocked_id = conv.trainer_id)
       or (b.blocker_id = conv.trainer_id and b.blocked_id = conv.client_id)
  ) then
    return false;
  end if;
  if conv.kind = 'enrollment' then
    return app.has_entitlement(conv.client_id, conv.trainer_id, 'messaging');
  elsif conv.kind = 'inquiry' then
    -- pre-sale inquiry must be explicitly enabled by the trainer
    return exists (
      select 1 from public.trainer_profiles tp
      where tp.user_id = conv.trainer_id
        and tp.is_public and tp.application_status = 'approved'
        and tp.is_accepting_clients
    );
  end if;
  return conv.kind = 'support';
end
$$;

create table public.user_blocks (
  blocker_id uuid not null references public.users (id) on delete cascade,
  blocked_id uuid not null references public.users (id) on delete cascade,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.users (id),
  kind public.message_kind not null default 'text',
  body text not null default '' check (char_length(body) <= 8000),
  attachment_id uuid, -- fk added below
  reply_to_id uuid references public.messages (id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint body_or_attachment check (kind <> 'text' or char_length(body) > 0)
);

create index messages_conversation_idx on public.messages (conversation_id, created_at desc, id);

create or replace function app.stamp_conversation_last_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end
$$;

create trigger messages_stamp_conversation
  after insert on public.messages
  for each row execute function app.stamp_conversation_last_message();

create table public.message_receipts (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (message_id, user_id)
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null references public.media_objects (id),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  uploaded_by uuid not null references public.users (id),
  created_at timestamptz not null default now()
);

alter table public.messages
  add constraint messages_attachment_fk
  foreign key (attachment_id) references public.attachments (id) on delete set null;

create index attachments_conversation_idx on public.attachments (conversation_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_receipts enable row level security;
alter table public.attachments enable row level security;
alter table public.user_blocks enable row level security;

create policy conversations_participant_select on public.conversations
  for select using (app.is_conversation_participant(id));

create policy conversation_participants_select on public.conversation_participants
  for select using (
    user_id = auth.uid() or app.is_conversation_participant(conversation_id)
  );
create policy conversation_participants_update_self on public.conversation_participants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Messages: participants read; sender must be the authenticated user (no
-- client-controlled sender IDs) and messaging must be currently entitled.
create policy messages_participant_select on public.messages
  for select using (app.is_conversation_participant(conversation_id));
create policy messages_send on public.messages
  for insert with check (
    sender_id = auth.uid()
    and kind in ('text', 'attachment')
    and app.can_message(conversation_id)
  );

create policy message_receipts_select on public.message_receipts
  for select using (
    user_id = auth.uid()
    or exists (select 1 from public.messages m
               where m.id = message_receipts.message_id and m.sender_id = auth.uid())
  );
create policy message_receipts_upsert_self on public.message_receipts
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.messages m
                where m.id = message_receipts.message_id
                  and app.is_conversation_participant(m.conversation_id))
  );
create policy message_receipts_update_self on public.message_receipts
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy attachments_participant_select on public.attachments
  for select using (app.is_conversation_participant(conversation_id));
create policy attachments_insert on public.attachments
  for insert with check (
    uploaded_by = auth.uid()
    and app.can_message(conversation_id)
    and exists (select 1 from public.media_objects m
                where m.id = attachments.media_id
                  and m.owner_id = auth.uid()
                  and m.status = 'published')
  );

-- Attachment media readable by conversation participants.
create policy media_objects_attachment_select on public.media_objects
  for select using (
    exists (select 1 from public.attachments a
            where a.media_id = media_objects.id
              and app.is_conversation_participant(a.conversation_id))
  );

create policy user_blocks_own on public.user_blocks
  for all using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- Conversation creation is server-mediated (enrollment activation / inquiry flow).
revoke insert, update, delete on public.conversations from anon, authenticated;
revoke insert, update, delete on public.conversation_participants from anon, authenticated;
revoke update, delete on public.messages from anon, authenticated;
revoke delete on public.message_receipts from anon, authenticated;
revoke update, delete on public.attachments from anon, authenticated;

-- Re-grant what the policies actually allow (revokes above narrowed the grants).
grant update (archived_at, notifications_muted) on public.conversation_participants to authenticated;
