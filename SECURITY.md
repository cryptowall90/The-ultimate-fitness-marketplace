# Security policy

## Reporting a vulnerability

Email **security@fitmarket.example** (placeholder until the production domain is live) with
a description, reproduction steps, and impact. Please do not open public issues for
security reports and do not test against production data.

- Acknowledgement within 2 business days; triage within 5.
- Authorization bugs (cross-tenant access, payment integrity) are treated as release
  blockers and hotfixed.
- Good-faith research within scope (your own accounts, no data exfiltration, no service
  degradation) will not be pursued legally.

## Scope highlights

The authorization model, payment rules and hardening controls are documented in
`docs/SECURITY.md` and `docs/THREAT_MODEL.md`. The RLS test suite
(`packages/database/test`) encodes the tenant-isolation guarantees; a failing RLS test
must never ship.
