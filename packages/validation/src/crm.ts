import { z } from "zod";
import { email, isoTimestamp, shortText, uuid } from "./primitives.js";

export const leadStageSchema = z.enum([
  "lead",
  "contacted",
  "consultation_scheduled",
  "awaiting_payment",
  "active_client",
  "paused",
  "completed",
  "canceled",
  "former_client",
]);

/** Manually tracked prospect (pre-purchase pipeline). */
export const leadCreateSchema = z
  .object({
    displayName: shortText(120, 1),
    email: email.optional(),
    source: z.enum(["manual", "inquiry", "purchase", "referral"]).default("manual"),
    stage: leadStageSchema.default("lead"),
    notes: shortText(4000),
  })
  .strict();

export const leadStageUpdateSchema = z
  .object({
    leadId: uuid,
    stage: leadStageSchema,
  })
  .strict();

/** Private trainer note — never visible to the client. */
export const trainerNoteCreateSchema = z
  .object({
    clientId: uuid,
    body: shortText(8000, 1),
  })
  .strict();

/** Client-visible note or assignment. */
export const clientVisibleNoteCreateSchema = z
  .object({
    clientId: uuid,
    title: shortText(200, 1),
    body: shortText(8000),
    kind: z.enum(["note", "assignment"]).default("note"),
    dueAt: isoTimestamp.optional(),
  })
  .strict();

export const taskCreateSchema = z
  .object({
    clientId: uuid.optional(),
    title: shortText(200, 1),
    description: shortText(4000),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    dueAt: isoTimestamp.optional(),
  })
  .strict();

export const taskStatusSchema = z
  .object({
    taskId: uuid,
    status: z.enum(["open", "in_progress", "done", "canceled"]),
  })
  .strict();
