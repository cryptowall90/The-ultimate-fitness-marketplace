-- 0010: trainer CRM — pipeline, client records, tags, notes, tasks, forms,
-- check-ins, measurements, progress photos, documents.

create table public.crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid references public.trainer_profiles (user_id) on delete cascade,
  stage public.lead_stage not null,
  label text not null check (char_length(label) <= 100),
  sort_order int not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (trainer_id, stage)
);

-- platform-default rows (trainer_id null) must also be unique per stage
create unique index crm_pipeline_stages_default_unique
  on public.crm_pipeline_stages (stage) where trainer_id is null;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid references public.users (id) on delete set null,
  display_name text not null check (char_length(display_name) <= 120),
  email citext,
  source text not null default 'manual' check (source in ('manual', 'inquiry', 'purchase', 'referral')),
  stage public.lead_stage not null default 'lead',
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger leads_touch before update on public.leads
  for each row execute function app.touch_updated_at();

create index leads_trainer_idx on public.leads (trainer_id, stage);

-- One CRM record per trainer-client relationship.
create table public.crm_client_records (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid not null references public.users (id) on delete cascade,
  stage public.lead_stage not null default 'active_client',
  risk_flag text check (risk_flag in ('inactive', 'at_risk', 'payment_failed')),
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trainer_id, client_id)
);

create trigger crm_client_records_touch before update on public.crm_client_records
  for each row execute function app.touch_updated_at();

create index crm_client_records_trainer_idx on public.crm_client_records (trainer_id, stage);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (trainer_id, name)
);

create table public.client_tags (
  crm_record_id uuid not null references public.crm_client_records (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (crm_record_id, tag_id)
);

-- Private trainer notes: NEVER visible to the client.
create table public.trainer_notes (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid not null references public.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 8000),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trainer_notes_touch before update on public.trainer_notes
  for each row execute function app.touch_updated_at();

create index trainer_notes_trainer_client_idx on public.trainer_notes (trainer_id, client_id);

-- Client-visible notes / assignments from the trainer.
create table public.client_visible_notes (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid not null references public.users (id) on delete cascade,
  title text not null check (char_length(title) <= 200),
  body text not null default '' check (char_length(body) <= 8000),
  kind text not null default 'note' check (kind in ('note', 'assignment')),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger client_visible_notes_touch before update on public.client_visible_notes
  for each row execute function app.touch_updated_at();

create index client_visible_notes_client_idx on public.client_visible_notes (client_id);
create index client_visible_notes_trainer_idx on public.client_visible_notes (trainer_id, client_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid references public.users (id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 4000),
  status public.task_status not null default 'open',
  priority public.task_priority not null default 'medium',
  due_at timestamptz,
  recurrence_rule text check (char_length(recurrence_rule) <= 200), -- RFC5545 RRULE subset
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tasks_touch before update on public.tasks
  for each row execute function app.touch_updated_at();

create index tasks_trainer_due_idx on public.tasks (trainer_id, status, due_at);

create table public.task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  remind_at timestamptz not null,
  channel public.notification_channel not null default 'push',
  sent_at timestamptz, -- set exactly once by the notification job (dedupe)
  created_at timestamptz not null default now(),
  unique (task_id, remind_at, channel)
);

create index task_reminders_due_idx on public.task_reminders (remind_at) where sent_at is null;

create table public.form_templates (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  kind text not null default 'form' check (kind in ('form', 'check_in')),
  is_archived boolean not null default false,
  current_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger form_templates_touch before update on public.form_templates
  for each row execute function app.touch_updated_at();

-- Versioned field definitions. JSONB is appropriate here: genuinely flexible,
-- versioned configuration validated by shared Zod schemas.
create table public.form_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.form_templates (id) on delete cascade,
  version int not null,
  fields jsonb not null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

create trigger form_template_versions_immutable
  before update or delete on public.form_template_versions
  for each row execute function app.forbid_mutation();

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null references public.form_template_versions (id),
  trainer_id uuid not null references public.trainer_profiles (user_id),
  client_id uuid not null references public.users (id),
  enrollment_id uuid references public.enrollments (id),
  answers jsonb not null,
  submitted_at timestamptz not null default now(),
  trainer_feedback text check (char_length(trainer_feedback) <= 4000),
  feedback_at timestamptz,
  created_at timestamptz not null default now()
);

create index form_submissions_trainer_idx on public.form_submissions (trainer_id, client_id);
create index form_submissions_client_idx on public.form_submissions (client_id);

create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid not null references public.users (id) on delete cascade,
  enrollment_id uuid references public.enrollments (id),
  template_id uuid references public.form_templates (id),
  due_at timestamptz not null,
  status public.check_in_status not null default 'scheduled',
  submission_id uuid references public.form_submissions (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger check_ins_touch before update on public.check_ins
  for each row execute function app.touch_updated_at();

create index check_ins_client_due_idx on public.check_ins (client_id, status, due_at);
create index check_ins_trainer_due_idx on public.check_ins (trainer_id, status, due_at);

create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.users (id) on delete cascade,
  recorded_by uuid not null references public.users (id),
  measured_at date not null default current_date,
  metric text not null check (metric in
    ('weight_kg', 'body_fat_pct', 'chest_cm', 'waist_cm', 'hips_cm', 'arm_cm',
     'thigh_cm', 'height_cm', 'resting_hr_bpm')),
  value numeric(7, 2) not null check (value > 0 and value < 100000),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (client_id, metric, measured_at)
);

create index measurements_client_idx on public.measurements (client_id, metric, measured_at desc);

-- Private progress photos. shared_with_trainer gates trainer visibility.
create table public.progress_photos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.users (id) on delete cascade,
  media_id uuid not null references public.media_objects (id) on delete cascade,
  taken_at date,
  note text check (char_length(note) <= 500),
  shared_with_trainer boolean not null default false,
  created_at timestamptz not null default now(),
  unique (media_id)
);

create index progress_photos_client_idx on public.progress_photos (client_id, created_at desc);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  trainer_id uuid not null references public.trainer_profiles (user_id) on delete cascade,
  client_id uuid references public.users (id) on delete cascade,
  media_id uuid not null references public.media_objects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now()
);

create index documents_trainer_idx on public.documents (trainer_id, client_id);

-- ---------------------------------------------------------------------------
-- RLS. Trainer-owned CRM data is visible only to that trainer; client-facing
-- artifacts (visible notes, check-ins, submissions, measurements) are also
-- visible to the client. Trainer access to client-created data requires a
-- relationship AND (for photos) explicit sharing.
-- ---------------------------------------------------------------------------

alter table public.crm_pipeline_stages enable row level security;
alter table public.leads enable row level security;
alter table public.crm_client_records enable row level security;
alter table public.tags enable row level security;
alter table public.client_tags enable row level security;
alter table public.trainer_notes enable row level security;
alter table public.client_visible_notes enable row level security;
alter table public.tasks enable row level security;
alter table public.task_reminders enable row level security;
alter table public.form_templates enable row level security;
alter table public.form_template_versions enable row level security;
alter table public.form_submissions enable row level security;
alter table public.check_ins enable row level security;
alter table public.measurements enable row level security;
alter table public.progress_photos enable row level security;
alter table public.documents enable row level security;

create policy crm_stages_select on public.crm_pipeline_stages
  for select using (trainer_id is null or trainer_id = auth.uid());
create policy crm_stages_owner_write on public.crm_pipeline_stages
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

create policy leads_owner_all on public.leads
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

create policy crm_client_records_owner_all on public.crm_client_records
  for all using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and app.trainer_client_relationship(trainer_id, client_id)
  );

create policy tags_owner_all on public.tags
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

create policy client_tags_owner_all on public.client_tags
  for all using (
    exists (select 1 from public.crm_client_records r
            where r.id = client_tags.crm_record_id and r.trainer_id = auth.uid())
  ) with check (
    exists (select 1 from public.crm_client_records r
            where r.id = client_tags.crm_record_id and r.trainer_id = auth.uid())
  );

-- Private notes: trainer only. No client policy exists — clients can never read.
create policy trainer_notes_owner_all on public.trainer_notes
  for all using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and app.trainer_client_relationship(trainer_id, client_id)
  );

create policy client_visible_notes_trainer_all on public.client_visible_notes
  for all using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and app.trainer_client_relationship(trainer_id, client_id)
  );
create policy client_visible_notes_client_select on public.client_visible_notes
  for select using (client_id = auth.uid());
create policy client_visible_notes_client_complete on public.client_visible_notes
  for update using (client_id = auth.uid()) with check (client_id = auth.uid());

create policy tasks_owner_all on public.tasks
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

create policy task_reminders_owner_all on public.task_reminders
  for all using (
    exists (select 1 from public.tasks t
            where t.id = task_reminders.task_id and t.trainer_id = auth.uid())
  ) with check (
    exists (select 1 from public.tasks t
            where t.id = task_reminders.task_id and t.trainer_id = auth.uid())
  );

create policy form_templates_owner_all on public.form_templates
  for all using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());

create policy form_template_versions_owner_select on public.form_template_versions
  for select using (
    exists (select 1 from public.form_templates t
            where t.id = form_template_versions.template_id and t.trainer_id = auth.uid())
  );
create policy form_template_versions_owner_insert on public.form_template_versions
  for insert with check (
    exists (select 1 from public.form_templates t
            where t.id = form_template_versions.template_id and t.trainer_id = auth.uid())
  );
-- Clients can read the template version behind their check-ins/submissions.
create policy form_template_versions_client_select on public.form_template_versions
  for select using (
    exists (select 1 from public.check_ins c
            where c.template_id = form_template_versions.template_id
              and c.client_id = auth.uid())
  );

create policy form_submissions_trainer_select on public.form_submissions
  for select using (trainer_id = auth.uid());
create policy form_submissions_trainer_feedback on public.form_submissions
  for update using (trainer_id = auth.uid()) with check (trainer_id = auth.uid());
create policy form_submissions_client_select on public.form_submissions
  for select using (client_id = auth.uid());
create policy form_submissions_client_insert on public.form_submissions
  for insert with check (
    client_id = auth.uid()
    and app.trainer_client_relationship(trainer_id, client_id)
  );

create policy check_ins_trainer_all on public.check_ins
  for all using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and app.trainer_client_relationship(trainer_id, client_id)
  );
create policy check_ins_client_select on public.check_ins
  for select using (client_id = auth.uid());
create policy check_ins_client_submit on public.check_ins
  for update using (client_id = auth.uid()) with check (client_id = auth.uid());

-- Measurements: the client owns them; the trainer may read/write during a relationship.
create policy measurements_client_all on public.measurements
  for all using (client_id = auth.uid()) with check (client_id = auth.uid() and recorded_by = auth.uid());
create policy measurements_trainer_select on public.measurements
  for select using (app.is_trainer_of(client_id));
create policy measurements_trainer_insert on public.measurements
  for insert with check (recorded_by = auth.uid() and app.is_trainer_of(client_id));

-- Progress photos: private by default; trainer sees only shared photos during a relationship.
create policy progress_photos_client_all on public.progress_photos
  for all using (client_id = auth.uid()) with check (client_id = auth.uid());
create policy progress_photos_trainer_select on public.progress_photos
  for select using (shared_with_trainer and app.is_trainer_of(client_id));

-- Trainer can read media rows behind photos shared with them (signed URLs are
-- still issued server-side with an audit record).
create policy media_objects_shared_progress_select on public.media_objects
  for select using (
    exists (select 1 from public.progress_photos pp
            where pp.media_id = media_objects.id
              and pp.shared_with_trainer
              and app.is_trainer_of(pp.client_id))
  );

create policy documents_trainer_all on public.documents
  for all using (trainer_id = auth.uid())
  with check (
    trainer_id = auth.uid()
    and (client_id is null or app.trainer_client_relationship(trainer_id, client_id))
  );
create policy documents_client_select on public.documents
  for select using (client_id = auth.uid());
