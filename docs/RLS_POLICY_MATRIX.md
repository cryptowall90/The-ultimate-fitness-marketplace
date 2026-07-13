# RLS policy matrix

Default deny everywhere (RLS enabled, no policy = no access). ✎ = write allowed with
row/column conditions; ✓ = read allowed with row conditions; SR = service-role/privileged
server only (client privileges REVOKEd). Tests: `packages/database/test/*.test.ts`.

| Table | Anon | Client (self) | Trainer (related) | Moderator | Writes |
| --- | --- | --- | --- | --- | --- |
| users, user_roles | — | ✓ own | — | — | SR |
| profiles | ✓ public trainers | ✓✎ own | ✓ during relationship | — | own row |
| client_profiles | — | ✓✎ own | ✓ during relationship | — | own row |
| trainer_profiles | ✓ public+approved | ✓✎ own (not approval cols) | — | — | own; approval SR |
| trainer_service_locations | — | — | ✓✎ own only | — | own |
| specialties / terms / feature_flags / rating summaries | ✓ | ✓ | ✓ | ✓ | SR (or owner where noted) |
| trainer_credentials | — | — | ✓✎ own (status SR) | ✓ | own; verification SR |
| media_objects | public_profile published | ✓✎ own | shared progress / attachments | — | own insert pending; publish SR |
| progress_photos | — | ✓✎ own | ✓ if shared_with_trainer | — | client |
| programs | ✓ published (public trainer) | — | ✓✎ own | — | trainer |
| program_versions / purchase_snapshots | — | ✓ own purchases | ✓ own | — | SR / immutable |
| orders, payments, refunds | — | ✓ own | ✓ own | — | SR only |
| payment_ledger, transfers, payouts, disputes | — | ✓ own rows | ✓ own rows | — | SR only, append-only |
| active_client_billing_ledger | — | — | ✓ own | — | SR only, append-only |
| subscription accounts/periods, connected accounts | — | — | ✓ own | — | SR only |
| enrollments, entitlements, status history | — | ✓ own | ✓ own | — | SR only |
| conversations / participants | — | ✓ participant | ✓ participant | ✓ via open escalation case | SR create; participant prefs |
| messages | — | ✓ participant; ✎ send when entitled, sender=self | same | ✓ via case | insert only |
| attachments / receipts | — | participant | participant | — | participant-scoped |
| reviews | ✓ published | ✓✎ own (edit window) | ✓; ✎ response only | ✓ | insert gated by can_review |
| review_reports, reports | — | ✓✎ own | ✓✎ own | ✓✎ | reporter insert |
| CRM (leads, records, tags, notes, tasks, forms, check-ins, documents) | — | ✓ client-facing rows; ✎ submissions/check-ins | ✓✎ own book (relationship-gated) | — | trainer/client as shown |
| trainer_notes | — | **never** | ✓✎ own | — | trainer |
| measurements | — | ✓✎ own | ✓✎ during relationship | — | recorder=self |
| notifications / prefs / push tokens | — | ✓✎ own | ✓✎ own | — | own |
| moderation_cases | — | — | — | ✓✎ | moderator |
| admin_actions, audit_logs, system_settings, webhook_events, idempotency_records, scheduled_job_runs | — | — | — | — | SR only |
| favorites, user_blocks, consent, export/deletion requests | — | ✓✎ own | ✓✎ own | — | own |

Helper functions (SECURITY DEFINER, `app` schema): `has_role`, `is_admin`, `is_moderator`,
`trainer_client_relationship`, `is_trainer_of`, `has_entitlement`,
`is_conversation_participant`, `can_message`, `can_review`, `is_service_context`.

Rule: any new table lands with its row here, policies in the same migration, and
cross-tenant tests before merge.
