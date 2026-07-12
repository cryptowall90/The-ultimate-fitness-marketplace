# Data model

Source of truth: `packages/database/migrations` (13 ordered SQL files, 75 tables).
UUID (`gen_random_uuid`) primary keys everywhere; `created_at`/`updated_at` (touch
trigger); explicit status enums; soft deletion only where retention requires it
(`media_objects.deleted_at`, user status).

## Domain groups

| Group | Tables | Notes |
| --- | --- | --- |
| Identity | users, user_roles, profiles, client_profiles, trainer_profiles, trainer_service_locations, specialties, trainer_specialties, trainer_credentials, trainer_availability, terms_versions, user_terms_acceptances, consent_records | `users` mirrors `auth.users` via signup trigger; approval columns trigger-guarded |
| Media | media_objects, media_access_logs | one table backs avatars/credentials/progress/attachments; random object keys; status pipeline pending→quarantined→processing→published |
| Trainer billing | stripe_connected_accounts, trainer_subscription_accounts, trainer_subscription_periods, trainer_billing_policy, active_client_billing_ledger | ledger append-only; unique (enrollment, period_start) |
| Commerce | programs, program_versions, program_purchase_snapshots, orders, payments, payment_ledger, refunds, disputes, transfers, payouts, idempotency_records, webhook_events | versions/snapshots/ledger immutable; state machines trigger-enforced |
| Enrollment | enrollments, enrollment_status_history, entitlements | history auto-recorded; entitlements unique (enrollment, type) |
| Messaging | conversations, conversation_participants, messages, message_receipts, attachments, user_blocks | one conversation per enrollment (unique FK) |
| Reviews | reviews, review_reports, favorites, trainer_rating_summaries | unique (enrollment); Bayesian aggregate maintained by trigger |
| CRM | crm_pipeline_stages, leads, crm_client_records, tags, client_tags, trainer_notes, client_visible_notes, tasks, task_reminders, form_templates, form_template_versions, form_submissions, check_ins, measurements, progress_photos, documents | template versions immutable; JSONB only for versioned field definitions/answers |
| Platform | notifications, notification_preferences, device_push_tokens, reports, moderation_cases, admin_actions, audit_logs, feature_flags, system_settings, scheduled_job_runs, data_export_requests, deletion_requests | admin_actions/audit_logs append-only |

## Deliberate JSONB usage (and nothing else)

`webhook_events.payload`, `stripe_connected_accounts.requirements_due`,
`program_versions.snapshot`, `form_template_versions.fields`, `form_submissions.answers`,
`media_objects.variants`, `feature_flags.audience`, `system_settings.value`,
`scheduled_job_runs.metadata`, audit metadata — provider snapshots or versioned flexible
configuration, all validated by shared Zod schemas at the boundary.

## Indexes (by query shape)

- Geo: `trainer_service_locations_public_point_gist` (GIST) — radius search;
  verified by an EXPLAIN test.
- Search: trigram GIN on `trainer_profiles.headline`, `programs.title`; FTS GIN on
  `trainer_profiles.about`; partial index on public approved trainers and published
  programs.
- Billing scans: `enrollments_billing_scan_idx` (trainer, start, end, partial by status);
  `acbl_trainer_period_idx`; partial status indexes on webhook_events / acbl.
- Messaging: `(conversation_id, created_at desc, id)` for keyset pagination;
  conversation lists by `(client_id|trainer_id, last_message_at desc)`.
- CRM: `(trainer_id, stage)`, task due-date, check-in due indexes.
- Uniqueness as business rules: one review per enrollment, one billing row per
  (enrollment, period), one primary location per trainer, one favorite per target, one
  platform-default pipeline stage per stage, webhook (provider, event_id).

## Migration policy

Forward-only, transactional, recorded in `schema_migrations` (RLS-locked). The local shim
(`migrations-local/`) emulates Supabase auth only when the `auth` schema is absent and is
never applied to real Supabase projects.
