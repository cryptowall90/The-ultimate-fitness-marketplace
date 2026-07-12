import { z } from "zod";
import { shortText, uuid } from "./primitives.js";

export const sendMessageSchema = z
  .object({
    conversationId: uuid,
    body: shortText(8000, 1),
    replyToId: uuid.optional(),
    // sender is ALWAYS taken from the authenticated session, never the payload
  })
  .strict();

export const attachMediaSchema = z
  .object({
    conversationId: uuid,
    mediaId: uuid,
  })
  .strict();

export const markReadSchema = z
  .object({
    conversationId: uuid,
    lastMessageId: uuid,
  })
  .strict();
