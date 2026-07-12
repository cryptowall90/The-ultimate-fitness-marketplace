import { z } from "zod";
import { shortText } from "./primitives.js";

/** Versioned form-template field definitions (stored as JSONB, validated here). */
const baseField = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,50}$/),
  label: shortText(200, 1),
  required: z.boolean().default(false),
});

export const formFieldSchema = z.discriminatedUnion("type", [
  baseField.extend({ type: z.literal("text"), maxLength: z.number().int().min(1).max(4000).default(500) }),
  baseField.extend({
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  baseField.extend({
    type: z.literal("choice"),
    options: z.array(shortText(100)).min(2).max(20),
    multiple: z.boolean().default(false),
  }),
  baseField.extend({ type: z.literal("date") }),
  baseField.extend({ type: z.literal("consent"), statement: shortText(1000) }),
  baseField.extend({ type: z.literal("file") }),
]);

export const formTemplateSchema = z
  .object({
    name: shortText(200, 1),
    kind: z.enum(["form", "check_in"]),
    fields: z.array(formFieldSchema).min(1).max(50),
  })
  .strict()
  .refine((t) => new Set(t.fields.map((f) => f.key)).size === t.fields.length, {
    message: "field keys must be unique",
  });

/** Validate a submission's answers against a template's field definitions. */
export function buildSubmissionSchema(fields: z.infer<typeof formFieldSchema>[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let s: z.ZodTypeAny;
    switch (field.type) {
      case "text":
        s = z.string().max(field.maxLength);
        break;
      case "number": {
        let n = z.number();
        if (field.min !== undefined) n = n.min(field.min);
        if (field.max !== undefined) n = n.max(field.max);
        s = n;
        break;
      }
      case "choice":
        s = field.multiple
          ? z.array(z.enum(field.options as [string, ...string[]])).min(1)
          : z.enum(field.options as [string, ...string[]]);
        break;
      case "date":
        s = z.string().date();
        break;
      case "consent":
        s = field.required ? z.literal(true) : z.boolean();
        break;
      case "file":
        s = z.string().uuid();
        break;
    }
    shape[field.key] = field.required ? s : s.optional();
  }
  return z.object(shape).strict();
}
