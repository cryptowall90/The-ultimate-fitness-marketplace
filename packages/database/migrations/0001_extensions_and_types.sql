-- 0001: extensions, enums, app helper schema.

create extension if not exists pgcrypto;
create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Enums. New values may be appended with ALTER TYPE ... ADD VALUE; never reuse
-- or repurpose existing values.
-- ---------------------------------------------------------------------------

create type public.app_role as enum ('client', 'trainer', 'moderator', 'admin');

create type public.user_status as enum ('active', 'suspended', 'deactivated', 'deleted');

create type public.trainer_application_status as enum
  ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'suspended');

create type public.service_mode as enum ('online', 'in_person', 'hybrid');

create type public.credential_status as enum ('pending', 'verified', 'rejected', 'expired');

create type public.program_status as enum ('draft', 'published', 'paused', 'archived');

create type public.pricing_type as enum ('one_time', 'recurring');

create type public.duration_unit as enum ('day', 'week', 'month');

create type public.enrollment_approval_policy as enum ('automatic', 'manual');

create type public.order_status as enum
  ('created', 'awaiting_payment', 'paid', 'canceled', 'expired', 'failed',
   'refunded', 'partially_refunded');

create type public.payment_status as enum
  ('requires_action', 'processing', 'succeeded', 'failed', 'canceled',
   'refunded', 'partially_refunded');

create type public.refund_status as enum ('pending', 'succeeded', 'failed', 'canceled');

create type public.dispute_status as enum
  ('warning_needs_response', 'needs_response', 'under_review', 'won', 'lost', 'closed');

create type public.transfer_status as enum ('pending', 'paid', 'failed', 'reversed', 'partially_reversed');

create type public.payout_status as enum ('pending', 'in_transit', 'paid', 'failed', 'canceled');

create type public.ledger_direction as enum ('debit', 'credit');

create type public.ledger_account as enum
  ('platform_revenue', 'trainer_receivable', 'client_payment', 'stripe_fees',
   'refunds', 'disputes', 'platform_subscription', 'active_client_fee', 'adjustments');

create type public.enrollment_status as enum
  ('pending_payment', 'pending_acceptance', 'scheduled', 'active', 'paused',
   'completed', 'expired', 'canceled', 'refunded', 'terminated');

create type public.entitlement_type as enum ('program_content', 'messaging', 'review');

create type public.entitlement_status as enum ('active', 'expired', 'revoked');

create type public.billing_ledger_status as enum ('pending', 'invoiced', 'finalized', 'voided');

create type public.subscription_status as enum
  ('incomplete', 'trialing', 'active', 'past_due', 'grace_period', 'suspended', 'canceled');

create type public.conversation_status as enum ('active', 'read_only', 'archived');

create type public.message_kind as enum ('text', 'attachment', 'system', 'support');

create type public.review_moderation_status as enum
  ('pending', 'published', 'under_review', 'removed');

create type public.report_status as enum ('open', 'triaged', 'actioned', 'dismissed');

create type public.report_target_type as enum
  ('user', 'message', 'review', 'trainer_profile', 'program', 'attachment');

create type public.moderation_case_status as enum ('open', 'in_review', 'resolved', 'escalated');

create type public.task_status as enum ('open', 'in_progress', 'done', 'canceled');

create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');

create type public.check_in_status as enum ('scheduled', 'due', 'submitted', 'reviewed', 'missed');

create type public.notification_channel as enum ('email', 'push', 'in_app');

create type public.media_status as enum
  ('pending_upload', 'quarantined', 'processing', 'published', 'rejected', 'deleted');

create type public.media_visibility as enum ('public_profile', 'private_progress', 'private_document');

create type public.job_run_status as enum ('running', 'succeeded', 'failed');

create type public.request_status as enum
  ('requested', 'in_progress', 'completed', 'rejected', 'canceled');

create type public.lead_stage as enum
  ('lead', 'contacted', 'consultation_scheduled', 'awaiting_payment',
   'active_client', 'paused', 'completed', 'canceled', 'former_client');

create type public.webhook_event_status as enum ('received', 'processing', 'processed', 'failed', 'dead_letter');

-- ---------------------------------------------------------------------------
-- app schema: security-definer helpers used by RLS policies. Not exposed via
-- PostgREST (only `public` is exposed on Supabase by default).
-- ---------------------------------------------------------------------------

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select auth.uid()
$$;

-- Placeholder bodies replaced in later migrations once the referenced tables exist.
create or replace function app.has_role(check_role public.app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select false
$$;
