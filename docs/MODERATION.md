# Moderation & abuse handling

## Reporting

Any user can report users, messages, reviews, profiles, programs or attachments
(`reports`, reporter-scoped RLS). Reports feed `moderation_cases` (open → in_review →
resolved/escalated), assignable to moderators.

## Access model

- Moderators read reports/cases and review-queue items via moderator policies.
- Conversation access is **case-gated**: a moderator participant row referencing an open
  escalation case is required for message visibility — no blanket message access. Every
  grant is auditable (participant row + case + audit log).
- Admin/high-risk actions (suspension, ledger adjustments, credential verification)
  require recent reauthentication + MFA (flag `mfa_enforcement_admins`), a reason string,
  and write immutable `admin_actions` rows; second-approver column for dual control.

## Review moderation

Reviews stay published unless they violate policy; trainer objections alone never remove a
review (root rule). Removal sets `moderation_status`, `removed_at`, `removal_reason` —
history preserved, aggregates recomputed automatically. Trainer responses are
column-guarded (response fields only).

## Abuse controls (layered)

Email verification → honeypot + Turnstile (flagged) on abuse-prone flows → per-IP/user
token buckets (API) + Cloudflare rules → message throttling and link/attachment
restrictions for new accounts (`messaging.new_account_link_block_hours`) → duplicate
content detection on reviews/messages → user blocking (`user_blocks`, enforced inside
`can_message`) → temporary/permanent suspension (`users.status`) with appeals through
support cases. Admin-configurable limits live in `system_settings`. No silent shadow
banning.
