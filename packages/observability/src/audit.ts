/**
 * Audit event helper: a typed shape for privileged-action audit records.
 * Persistence happens through the service-role database client in
 * services/api; this package only defines the contract.
 */
export interface AuditEvent {
  actorId: string | null;
  actorRole: string | null;
  event: string;
  targetType?: string;
  targetId?: string;
  correlationId?: string;
  /** Free-form, PII-reviewed metadata. Never include secrets or message bodies. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}
