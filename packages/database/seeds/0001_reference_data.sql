-- Reference data seeds. Idempotent (safe to re-run). No personal data.

insert into public.specialties (slug, name, description) values
  ('strength-training', 'Strength Training', 'Barbell, dumbbell and machine-based strength work'),
  ('weight-loss', 'Weight Loss', 'Sustainable fat loss coaching'),
  ('bodybuilding', 'Bodybuilding', 'Hypertrophy and physique preparation'),
  ('powerlifting', 'Powerlifting', 'Squat, bench, deadlift performance'),
  ('olympic-lifting', 'Olympic Lifting', 'Snatch and clean & jerk technique'),
  ('crossfit', 'CrossFit', 'Mixed-modal functional fitness'),
  ('running', 'Running', '5k to marathon coaching'),
  ('cycling', 'Cycling', 'Road and indoor cycling performance'),
  ('yoga', 'Yoga', 'Mobility, flexibility and mindfulness'),
  ('pilates', 'Pilates', 'Core strength and control'),
  ('prenatal-postnatal', 'Pre/Post-natal', 'Training through pregnancy and recovery'),
  ('senior-fitness', 'Senior Fitness', 'Healthy ageing and independence'),
  ('rehabilitation', 'Rehabilitation', 'Return-to-training after injury (non-medical)'),
  ('sports-performance', 'Sports Performance', 'Sport-specific athletic development'),
  ('nutrition-coaching', 'Nutrition Coaching', 'Habit-based nutrition support')
on conflict (slug) do nothing;

-- Default billing policy: $34.99 subscription + $2.50 per active client,
-- transaction commission disabled (0 bps) until an administrator enables it.
insert into public.trainer_billing_policy
  (platform_subscription_cents, active_client_fee_cents, transaction_commission_bps,
   currency, trial_days, grace_period_days, note)
select 3499, 250, 0, 'usd', 0, 7, 'Launch policy'
where not exists (select 1 from public.trainer_billing_policy);

-- Global default pipeline stages (trainer_id null = platform defaults).
insert into public.crm_pipeline_stages (trainer_id, stage, label, sort_order, is_default)
select null, v.stage::public.lead_stage, v.label, v.sort_order, true
from (values
  ('lead', 'Lead', 10),
  ('contacted', 'Contacted', 20),
  ('consultation_scheduled', 'Consultation scheduled', 30),
  ('awaiting_payment', 'Awaiting payment', 40),
  ('active_client', 'Active client', 50),
  ('paused', 'Paused', 60),
  ('completed', 'Completed', 70),
  ('canceled', 'Canceled', 80),
  ('former_client', 'Former client', 90)
) as v(stage, label, sort_order)
where not exists (
  select 1 from public.crm_pipeline_stages s
  where s.trainer_id is null and s.stage = v.stage::public.lead_stage
);

insert into public.feature_flags (key, description, enabled) values
  ('presale_inquiries', 'Allow clients to send limited pre-sale inquiries to trainers who opt in', false),
  ('sponsored_placement', 'Clearly-labeled sponsored search placement', false),
  ('turnstile_registration', 'Require Cloudflare Turnstile on registration', true),
  ('mfa_enforcement_admins', 'Require MFA for admin/moderator accounts', true)
on conflict (key) do nothing;

insert into public.system_settings (key, value, description) values
  ('search.max_radius_km', '160', 'Hard cap for geographic search radius (also enforced in SQL)'),
  ('search.default_radius_km', '40', 'Default in-person search radius'),
  ('messaging.max_message_length', '8000', 'Maximum message body length'),
  ('messaging.new_account_link_block_hours', '72', 'Hours during which new accounts cannot send links'),
  ('uploads.max_image_bytes', '1048576', 'Maximum post-compression image upload size'),
  ('uploads.per_user_quota_bytes', '524288000', 'Per-user media storage quota (500 MB)'),
  ('reviews.min_interval_seconds', '3600', 'Rate limit between review submissions per user'),
  ('billing.reconciliation_alert_threshold_cents', '100', 'Alert when Stripe/internal mismatch exceeds this')
on conflict (key) do nothing;

insert into public.terms_versions (kind, version, content_url, effective_at) values
  ('terms_of_service', '2026-07-01', 'https://example.invalid/legal/tos/2026-07-01', now()),
  ('privacy_policy', '2026-07-01', 'https://example.invalid/legal/privacy/2026-07-01', now()),
  ('trainer_agreement', '2026-07-01', 'https://example.invalid/legal/trainer/2026-07-01', now())
on conflict (kind, version) do nothing;
