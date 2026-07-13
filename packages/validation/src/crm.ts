import { z } from "zod";
import { isoTimestamp, shortText, uuid } from "./primitives.js";

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
