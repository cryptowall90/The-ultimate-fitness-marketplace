# Trainer CRM

Schema shipped in migration 0010; RLS restricts every object to the owning trainer, with
client-facing artifacts (visible notes, check-ins, submissions, measurements) also readable
by the client. Private trainer notes have **no client policy at all**.

## Pipeline

Stages (platform defaults seeded; per-trainer overrides in `crm_pipeline_stages`):
Lead → Contacted → Consultation scheduled → Awaiting payment → Active client → Paused →
Completed → Canceled → Former client. Purchases auto-create/refresh `crm_client_records`
at `active_client` (webhook path). Tags are trainer-scoped with junction `client_tags`.

## Client record view

Profile summary (relationship-gated), enrollments + status history, goals/availability,
measurements, shared progress photos, form submissions + feedback, check-ins, visible
notes/assignments, private notes, tasks, conversation link, payment status (orders RLS),
activity timeline (status history + last_activity_at), consents, documents, review status.

## Tasks & reminders

Due dates, priority, client link, RRULE-subset recurrence, completion state.
`task_reminders` are unique per (task, remind_at, channel) and `sent_at` is set exactly
once by the notification job — the uniqueness constraint prevents duplicate notification
execution.

## Forms & check-ins

Templates are versioned (`form_template_versions` immutable); field definitions are JSONB
validated by `formTemplateSchema`; submissions validated by `buildSubmissionSchema`
(strict, per-field rules). Check-ins schedule against templates with due dates and status
(scheduled → due → submitted → reviewed / missed) and link the submission.

## Analytics (trainer-scoped)

Revenue over time / payouts (payment_ledger + payouts), enrollments & churn
(enrollment_status_history), program conversion & performance (orders per program),
client LTV (ledger per client), active clients (billing ledger), review trends
(rating summaries), response time (message timestamps). All queries are trainer-scoped by
RLS; no cross-trainer aggregates are exposed.

## UI status

CRM screens (web `Overview/Leads/Clients/...` navigation) are Phase 7 work — the data
layer, authorization and dashboards queries above are in place; see
IMPLEMENTATION_STATUS.md.
