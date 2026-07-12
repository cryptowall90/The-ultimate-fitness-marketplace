-- 0011: notifications, reports/moderation, admin actions, audit logs, feature
-- flags, system settings, job runs, privacy requests.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (char_length(kind) <= 100),
  title text not null check (char_length(title) <= 200),
  body text not null default '' check (char_length(body) <= 1000),
  link_path text check (link_path ~ '^/[a-zA-Z0-9/_?&=.-]*$'), -- internal paths only
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc)
  ;

create table public.notification_preferences (
  user_id uuid not null references public.users (id) on delete cascade,
  category text not null check (category in
    ('messages', 'check_ins', 'tasks', 'billing', 'marketing', 'reviews', 'enrollment')),
  channel public.notification_channel not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, category, channel)
);

create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null default 'expo' check (provider in ('expo')),
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, token)
);

create index device_push_tokens_user_idx on public.device_push_tokens (user_id)
  where revoked_at is null;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users (id),
  target_type public.report_target_type not null,
  target_id uuid not null,
  reason text not null check (char_length(reason) between 3 and 2000),
  status public.report_status not null default 'open',
  moderation_case_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger reports_touch before update on public.reports
  for each row execute function app.touch_updated_at();

create index reports_status_idx on public.reports (status, created_at);
create index reports_target_idx on public.reports (target_type, target_id);

create table public.moderation_cases (
  id uuid primary key default gen_random_uuid(),
  status public.moderation_case_status not null default 'open',
  subject_user_id uuid references public.users (id),
  target_type public.report_target_type,
  target_id uuid,
  assigned_to uuid references public.users (id),
  summary text not null check (char_length(summary) <= 2000),
  resolution text check (char_length(resolution) <= 4000),
  resolved_at timestamptz,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger moderation_cases_touch before update on public.moderation_cases
  for each row execute function app.touch_updated_at();

create index moderation_cases_status_idx on public.moderation_cases (status, created_at);

alter table public.reports
  add constraint reports_case_fk
  foreign key (moderation_case_id) references public.moderation_cases (id) on delete set null;

alter table public.conversation_participants
  add constraint cp_escalation_case_fk
  foreign key (escalation_case_id) references public.moderation_cases (id);

-- Moderator conversation access requires an open escalation case naming them.
create policy conversations_moderator_case_select on public.conversations
  for select using (
    app.is_moderator() and exists (
      select 1 from public.conversation_participants cp
      join public.moderation_cases mc on mc.id = cp.escalation_case_id
      where cp.conversation_id = conversations.id
        and cp.user_id = auth.uid()
        and mc.status in ('open', 'in_review', 'escalated')
    )
  );
create policy messages_moderator_case_select on public.messages
  for select using (
    app.is_moderator() and exists (
      select 1 from public.conversation_participants cp
      join public.moderation_cases mc on mc.id = cp.escalation_case_id
      where cp.conversation_id = messages.conversation_id
        and cp.user_id = auth.uid()
        and mc.status in ('open', 'in_review', 'escalated')
    )
  );

-- Immutable admin action log (high-risk actions with reason).
create table public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.users (id),
  action text not null check (char_length(action) <= 100),
  target_type text not null check (char_length(target_type) <= 100),
  target_id text not null check (char_length(target_id) <= 100),
  reason text not null check (char_length(reason) between 3 and 2000),
  second_approver_id uuid references public.users (id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_actions_actor_idx on public.admin_actions (actor_id, created_at desc);
create index admin_actions_target_idx on public.admin_actions (target_type, target_id);

create trigger admin_actions_immutable
  before update or delete on public.admin_actions
  for each row execute function app.forbid_mutation();

alter table public.payment_ledger
  add constraint payment_ledger_admin_action_fk
  foreign key (admin_action_id) references public.admin_actions (id);

-- General security audit log (append-only).
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users (id),
  actor_role text,
  event text not null check (char_length(event) <= 100),
  target_type text,
  target_id text,
  ip_hash text,
  correlation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_event_idx on public.audit_logs (event, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

create trigger audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function app.forbid_mutation();

create table public.feature_flags (
  key text primary key check (key ~ '^[a-z0-9_.-]{2,100}$'),
  description text not null default '',
  enabled boolean not null default false,
  rollout_percent int not null default 100 check (rollout_percent between 0 and 100),
  audience jsonb not null default '{}'::jsonb,
  updated_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger feature_flags_touch before update on public.feature_flags
  for each row execute function app.touch_updated_at();

create table public.system_settings (
  key text primary key check (key ~ '^[a-z0-9_.-]{2,100}$'),
  value jsonb not null,
  description text not null default '',
  updated_by uuid references public.users (id),
  updated_at timestamptz not null default now()
);

create table public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null check (char_length(job_name) <= 100),
  status public.job_run_status not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  items_processed int not null default 0,
  error text,
  -- lock key prevents concurrent duplicate runs of a period-scoped job
  lock_key text,
  metadata jsonb not null default '{}'::jsonb
);

create unique index scheduled_job_runs_lock_idx on public.scheduled_job_runs (job_name, lock_key)
  where status = 'running' and lock_key is not null;
create index scheduled_job_runs_name_idx on public.scheduled_job_runs (job_name, started_at desc);

create table public.data_export_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  status public.request_status not null default 'requested',
  export_media_id uuid references public.media_objects (id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz
);

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  status public.request_status not null default 'requested',
  reason text check (char_length(reason) <= 1000),
  legal_hold boolean not null default false,
  requested_at timestamptz not null default now(),
  scheduled_purge_at timestamptz,
  completed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.device_push_tokens enable row level security;
alter table public.reports enable row level security;
alter table public.moderation_cases enable row level security;
alter table public.admin_actions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.feature_flags enable row level security;
alter table public.system_settings enable row level security;
alter table public.scheduled_job_runs enable row level security;
alter table public.data_export_requests enable row level security;
alter table public.deletion_requests enable row level security;

create policy notifications_own_select on public.notifications
  for select using (user_id = auth.uid());
create policy notifications_own_mark_read on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notification_preferences_own_all on public.notification_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy device_push_tokens_own_all on public.device_push_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy reports_insert_own on public.reports
  for insert with check (reporter_id = auth.uid());
create policy reports_select_own on public.reports
  for select using (reporter_id = auth.uid());
create policy reports_moderator_select on public.reports
  for select using (app.is_moderator());
create policy reports_moderator_update on public.reports
  for update using (app.is_moderator()) with check (app.is_moderator());

create policy moderation_cases_moderator on public.moderation_cases
  for all using (app.is_moderator()) with check (app.is_moderator());

-- admin_actions / audit_logs: no client policies (service-role writes; admin
-- portal reads through privileged server paths).

create policy feature_flags_select_all on public.feature_flags
  for select using (true);
revoke insert, update, delete on public.feature_flags from anon, authenticated;

-- system_settings may hold sensitive config: service-role only.
revoke all on public.system_settings from anon, authenticated;
revoke all on public.scheduled_job_runs from anon, authenticated;
revoke all on public.admin_actions from anon, authenticated;
revoke all on public.audit_logs from anon, authenticated;

create policy data_export_requests_own on public.data_export_requests
  for select using (user_id = auth.uid());
create policy data_export_requests_insert on public.data_export_requests
  for insert with check (user_id = auth.uid());

create policy deletion_requests_own on public.deletion_requests
  for select using (user_id = auth.uid());
create policy deletion_requests_insert on public.deletion_requests
  for insert with check (user_id = auth.uid() and legal_hold = false);
