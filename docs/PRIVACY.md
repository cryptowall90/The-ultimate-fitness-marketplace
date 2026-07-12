# Privacy

Privacy-by-design. Fitness data can be sensitive; we treat progress photos, measurements
and check-ins as high-sensitivity. **We do not market HIPAA compliance.**

## Data minimization & separation

- Public fields (trainer marketing profile) live apart from private fields; exact trainer
  addresses never leave owner-only rows.
- Progress photos are private by default; sharing with the trainer is an explicit per-photo
  flag the client controls.
- Analytics (PostHog adapter) receives distinct ids and coarse events only — no PII, no
  message text, no fitness data (`AnalyticsProvider` contract).
- Logs: redacting logger censors emails, tokens, message bodies, exact addresses.
- Uploads: EXIF/GPS stripped client-side and again by server re-encode.

## Consent & terms

`terms_versions` + `user_terms_acceptances` (versioned, timestamped, ip-hash);
`consent_records` for purpose-specific consents (e.g. photo sharing); notification
preferences per category/channel.

## Rights

- **Export**: `data_export_requests` → job assembles the user's rows + media into a bundle
  delivered as an expiring private download.
- **Deletion**: `deletion_requests` → grace window → purge job anonymizes profiles,
  messages metadata and media; **financial records are retained but redacted/anonymized**
  (legal retention), and `legal_hold` blocks purge until cleared.
- Retention schedule: messages per policy after enrollment end; quarantined media 30 days;
  audit/security logs per compliance retention; provider payload snapshots pruned after
  reconciliation windows.

## Roles & access

Trainers see client data only during a valid relationship and only what the client shares.
Moderators access conversations solely through audited escalation cases. Admin actions
require reason + immutable audit records.
