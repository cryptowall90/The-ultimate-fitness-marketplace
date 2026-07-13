import type pg from "pg";
import { withTransaction } from "../db.js";

export class ModerationError extends Error {
  constructor(
    public readonly code: "report_not_found" | "already_decided" | "remove_not_supported",
    message: string,
  ) {
    super(message);
  }
}

export interface ReportSummary {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
  /** Reported content preview for targets a moderator may inspect. */
  content: string | null;
}

/** Open/triaged reports, oldest first, with content previews where supported. */
export async function listOpenReports(pool: pg.Pool): Promise<ReportSummary[]> {
  const res = await pool.query(
    `select r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
            case r.target_type
              when 'review' then (select left(coalesce(rv.comment, ''), 500)
                                  from reviews rv where rv.id = r.target_id)
              when 'message' then (select left(m.body, 500)
                                   from messages m where m.id = r.target_id)
              else null
            end as content
     from reports r
     where r.status in ('open', 'triaged')
     order by r.created_at
     limit 100`,
  );
  return res.rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    content: row.content,
  }));
}

/** Dismisses a report with an audit entry. */
export async function dismissReport(
  pool: pg.Pool,
  input: { reportId: string; moderatorId: string; reason: string },
): Promise<{ reportId: string; status: "dismissed" }> {
  return withTransaction(pool, async (tx) => {
    await lockOpenReport(tx, input.reportId);
    await tx.query(`update reports set status = 'dismissed' where id = $1`, [input.reportId]);
    await recordModeration(tx, "report.dismiss", input);
    return { reportId: input.reportId, status: "dismissed" as const };
  });
}

/**
 * Marks a report actioned; optionally removes the reported content (review or
 * message). Runs in service context so the review-column guard permits the
 * moderation write, and rating aggregates are recomputed after removal.
 */
export async function actionReport(
  pool: pg.Pool,
  input: { reportId: string; moderatorId: string; reason: string; removeContent: boolean },
): Promise<{ reportId: string; status: "actioned"; contentRemoved: boolean }> {
  return withTransaction(pool, async (tx) => {
    const report = await lockOpenReport(tx, input.reportId);

    let contentRemoved = false;
    if (input.removeContent) {
      if (report.target_type === "review") {
        const removed = await tx.query(
          `update reviews
           set moderation_status = 'removed', removed_at = now(), removal_reason = $2
           where id = $1 and moderation_status <> 'removed'
           returning trainer_id`,
          [report.target_id, input.reason.slice(0, 500)],
        );
        if (removed.rowCount) {
          await tx.query(`select app.recompute_trainer_rating($1)`, [removed.rows[0].trainer_id]);
          contentRemoved = true;
        }
      } else if (report.target_type === "message") {
        const removed = await tx.query(
          `update messages set deleted_at = now(), body = ''
           where id = $1 and deleted_at is null`,
          [report.target_id],
        );
        contentRemoved = (removed.rowCount ?? 0) > 0;
      } else {
        throw new ModerationError(
          "remove_not_supported",
          "Content removal is only supported for review and message reports",
        );
      }
    }

    await tx.query(`update reports set status = 'actioned' where id = $1`, [input.reportId]);
    await recordModeration(tx, "report.action", input, { contentRemoved });
    return { reportId: input.reportId, status: "actioned" as const, contentRemoved };
  });
}

interface LockedReport {
  target_type: string;
  target_id: string;
}

async function lockOpenReport(tx: pg.PoolClient, reportId: string): Promise<LockedReport> {
  const res = await tx.query(
    `select status, target_type, target_id from reports where id = $1 for update`,
    [reportId],
  );
  const row = res.rows[0];
  if (!row) throw new ModerationError("report_not_found", "Report not found");
  if (!["open", "triaged"].includes(row.status)) {
    throw new ModerationError("already_decided", "Report has already been decided");
  }
  return row;
}

async function recordModeration(
  tx: pg.PoolClient,
  action: string,
  input: { reportId: string; moderatorId: string; reason: string },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `insert into admin_actions (actor_id, action, target_type, target_id, reason, metadata)
     values ($1, $2, 'report', $3, $4, $5)`,
    [input.moderatorId, action, input.reportId, input.reason, JSON.stringify(metadata)],
  );
}
