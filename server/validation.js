import { z } from "zod";
export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .transform((s) => s.replace(/[\s()-]/g, ""))
    .pipe(
      z
        .string()
        .regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +380..."),
    ),
});
export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(4000),
  recipient_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(10)
    .refine((a) => new Set(a).size === a.length, "Duplicate recipients"),
});
