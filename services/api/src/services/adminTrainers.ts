import type pg from "pg";
import { withTransaction } from "../db.js";

/**
 * Trainer application review. Runs on the privileged connection: the
 * trainer_profiles approval-column trigger only permits these transitions in
 * service context, so route-level admin authorization is mandatory before
 * calling into this module (see requireAdmin in app.ts).
 */

export class AdminTrainerError extends Error {
  constructor(
    readonly code: "application_not_found" | "invalid_application_state",
    message: string,
  ) {
    super(message);
  }
}

export interface TrainerApplicationListItem {
  trainerId: string;
  displayName: string;
  slug: string | null;
  headline: string;
  about: string;
  serviceMode: string;
  yearsExperience: number | null;
  languages: string[];
  businessName: string | null;
  applicationStatus: string;
  submittedAt: string | null;
  specialties: string[];
  credentials: { title: string; issuingOrganization: string; status: string }[];
}

export async function listTrainerApplications(
  pool: pg.Pool,
  status: "submitted" | "under_review",
): Promise<TrainerApplicationListItem[]> {
  const res = await pool.query(
    `select tp.user_id, p.display_name, tp.slug, tp.headline, tp.about, tp.service_mode,
            tp.years_experience, tp.languages, tp.business_name, tp.application_status,
            tp.application_submitted_at,
            coalesce((select array_agg(s.name order by s.name)
                      from trainer_specialties ts
                      join specialties s on s.id = ts.specialty_id
                      where ts.trainer_id = tp.user_id), '{}') as specialties,
            coalesce((select json_agg(json_build_object(
                        'title', tc.title,
                        'issuingOrganization', tc.issuing_organization,
                        'status', tc.status) order by tc.created_at)
                      from trainer_credentials tc
                      where tc.trainer_id = tp.user_id), '[]') as credentials
     from trainer_profiles tp
     join profiles p on p.user_id = tp.user_id
     where tp.application_status = $1
     order by tp.application_submitted_at asc nulls last
     limit 100`,
    [status],
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
    applicationStatus: row.application_status,
    submittedAt: row.application_submitted_at?.toISOString() ?? null,
    specialties: row.specialties,
    credentials: row.credentials,
  }));
}

export interface TrainerDecisionInput {
  trainerId: string;
  decision: "approved" | "rejected";
  reason: string;
  actorId: string;
}

export async function decideTrainerApplication(
  pool: pg.Pool,
  input: TrainerDecisionInput,
): Promise<{ trainerId: string; applicationStatus: "approved" | "rejected" }> {
  return withTransaction(pool, async (tx) => {
    const current = await tx.query(
      `select application_status from trainer_profiles where user_id = $1 for update`,
      [input.trainerId],
    );
    const row = current.rows[0];
    if (!row) {
      throw new AdminTrainerError("application_not_found", "Trainer application not found");
    }
    if (row.application_status !== "submitted" && row.application_status !== "under_review") {
      throw new AdminTrainerError(
        "invalid_application_state",
        `Application is ${row.application_status}; only submitted or under_review applications can be decided`,
      );
    }

    if (input.decision === "approved") {
      await tx.query(
        `update trainer_profiles
         set application_status = 'approved', approved_at = now(), approved_by = $2,
             rejection_reason = null, is_public = true
         where user_id = $1`,
        [input.trainerId, input.actorId],
      );
      await tx.query(
        `insert into user_roles (user_id, role, granted_by)
         values ($1, 'trainer', $2) on conflict do nothing`,
        [input.trainerId, input.actorId],
      );
    } else {
      await tx.query(
        `update trainer_profiles
         set application_status = 'rejected', rejection_reason = $2, is_public = false
         where user_id = $1`,
        [input.trainerId, input.reason],
      );
    }

    await tx.query(
      `insert into admin_actions (actor_id, action, target_type, target_id, reason)
       values ($1, $2, 'trainer_profile', $3, $4)`,
      [
        input.actorId,
        input.decision === "approved"
          ? "trainer_application_approved"
          : "trainer_application_rejected",
        input.trainerId,
        input.reason,
      ],
    );

    return { trainerId: input.trainerId, applicationStatus: input.decision };
  });
}
