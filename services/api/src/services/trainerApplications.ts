import type pg from "pg";
import { withTransaction } from "../db.js";

export class TrainerApplicationError extends Error {
  constructor(
    public readonly code: "application_not_found" | "invalid_status",
    message: string,
  ) {
    super(message);
  }
}

export interface TrainerApplicationSummary {
  trainerId: string;
  displayName: string;
  slug: string | null;
  headline: string;
  about: string;
  serviceMode: string;
  yearsExperience: number | null;
  languages: string[];
  businessName: string | null;
  submittedAt: string | null;
  specialties: string[];
  credentials: Array<{
    title: string;
    issuingOrganization: string;
    issuedAt: string | null;
    expiresAt: string | null;
    status: string;
  }>;
}

/** Applications awaiting a decision, oldest submission first. */
export async function listSubmittedApplications(
  pool: pg.Pool,
): Promise<TrainerApplicationSummary[]> {
  const res = await pool.query(
    `select tp.user_id, tp.slug, tp.headline, tp.about, tp.service_mode,
            tp.years_experience, tp.languages, tp.business_name,
            tp.application_submitted_at,
            coalesce(p.display_name, '') as display_name,
            coalesce(
              (select array_agg(s.name order by s.name)
               from trainer_specialties ts
               join specialties s on s.id = ts.specialty_id
               where ts.trainer_id = tp.user_id),
              '{}'
            ) as specialties,
            coalesce(
              (select jsonb_agg(jsonb_build_object(
                 'title', tc.title,
                 'issuingOrganization', tc.issuing_organization,
                 'issuedAt', tc.issued_at,
                 'expiresAt', tc.expires_at,
                 'status', tc.status
               ) order by tc.created_at)
               from trainer_credentials tc
               where tc.trainer_id = tp.user_id),
              '[]'::jsonb
            ) as credentials
     from trainer_profiles tp
     left join profiles p on p.user_id = tp.user_id
     where tp.application_status in ('submitted', 'under_review')
     order by tp.application_submitted_at asc nulls last
     limit 100`,
  );
  return res.rows.map((row) => ({
    trainerId: row.user_id,
    displayName: row.display_name,
    slug: row.slug,
    headline: row.headline,
    about: row.about,
    serviceMode: row.service_mode,
    yearsExperience: row.years_experience,
    languages: row.languages,
    businessName: row.business_name,
    submittedAt: row.application_submitted_at
      ? new Date(row.application_submitted_at).toISOString()
      : null,
    specialties: row.specialties,
    credentials: row.credentials,
  }));
}

/**
 * Approves a submitted application: grants the trainer role, publishes the
 * profile, and records the decision in the immutable admin_actions trail.
 * Runs in service context, so the approval-column guard trigger permits it.
 */
export async function approveTrainerApplication(
  pool: pg.Pool,
  input: { trainerId: string; adminId: string; reason: string },
): Promise<{ trainerId: string; status: "approved" }> {
  return withTransaction(pool, async (tx) => {
    await lockSubmittedApplication(tx, input.trainerId);
    await tx.query(
      `update trainer_profiles
       set application_status = 'approved', approved_at = now(), approved_by = $2,
           rejection_reason = null, is_public = true
       where user_id = $1`,
      [input.trainerId, input.adminId],
    );
    await tx.query(
      `insert into user_roles (user_id, role, granted_by)
       values ($1, 'trainer', $2) on conflict do nothing`,
      [input.trainerId, input.adminId],
    );
    await recordDecision(tx, "trainer_application.approve", input);
    return { trainerId: input.trainerId, status: "approved" as const };
  });
}

/** Rejects a submitted application with a reason shown to the applicant. */
export async function rejectTrainerApplication(
  pool: pg.Pool,
  input: { trainerId: string; adminId: string; reason: string },
): Promise<{ trainerId: string; status: "rejected" }> {
  return withTransaction(pool, async (tx) => {
    await lockSubmittedApplication(tx, input.trainerId);
    await tx.query(
      `update trainer_profiles
       set application_status = 'rejected', rejection_reason = $2, is_public = false
       where user_id = $1`,
      [input.trainerId, input.reason],
    );
    await recordDecision(tx, "trainer_application.reject", input);
    return { trainerId: input.trainerId, status: "rejected" as const };
  });
}

async function lockSubmittedApplication(tx: pg.PoolClient, trainerId: string): Promise<void> {
  const res = await tx.query(
    `select application_status from trainer_profiles where user_id = $1 for update`,
    [trainerId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new TrainerApplicationError("application_not_found", "Application not found");
  }
  if (!["submitted", "under_review"].includes(row.application_status)) {
    throw new TrainerApplicationError("invalid_status", "Application is not awaiting a decision");
  }
}

async function recordDecision(
  tx: pg.PoolClient,
  action: string,
  input: { trainerId: string; adminId: string; reason: string },
): Promise<void> {
  await tx.query(
    `insert into admin_actions (actor_id, action, target_type, target_id, reason)
     values ($1, $2, 'trainer_profile', $3, $4)`,
    [input.adminId, action, input.trainerId, input.reason],
  );
}
