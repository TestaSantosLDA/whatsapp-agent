/** Schema for clients/<id>.yaml: everything that differs between clients lives here. */
import { z } from 'zod';

const timeRange = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'expected HH:MM-HH:MM');

export const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof weekdaySchema>;

/** Opening hours per weekday; a day that is missing is closed. */
export const openingHoursSchema = z.partialRecord(weekdaySchema, z.array(timeRange));

export const branchSchema = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  address: z.string(),
  phone: z.string(),
  mobile: z.string().optional(),
  email: z.string().optional(),
  hours: openingHoursSchema,
  business_lines: z.array(z.string()),
  notes: z.string().optional(),
});
export type Branch = z.infer<typeof branchSchema>;

export const channelConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('simulator'),
    phone_number_id: z.string(),
    display_phone_number: z.string(),
  }),
  z.object({
    type: z.literal('whatsapp_cloud'),
    phone_number_id: z.string(),
    display_phone_number: z.string(),
    waba_id: z.string(),
    /** Name of the env variable holding the access token. Secrets never live in the YAML. */
    access_token_env: z.string(),
  }),
]);
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const clientConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  timezone: z.string().default('Europe/Lisbon'),
  languages: z.array(z.string()).min(1),
  default_language: z.string(),
  brand_voice: z.string(),
  channel: channelConfigSchema,
  catalogue: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('shopify'),
        store_url: z.url(),
        /** Added to checkout links as `?ref=` so the store can attribute orders to the agent. */
        checkout_ref: z.string().optional(),
      }),
    ])
    .optional(),
  business_lines: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  branches: z.array(branchSchema).min(1),
  routing: z.object({
    default_branch: z.string(),
    rules: z
      .array(
        z.object({
          business_line: z.string().optional(),
          regions: z.array(z.string()).optional(),
          branch: z.string(),
        }),
      )
      .default([]),
  }),
  lead: z.object({
    request_types: z.array(z.string()).min(1),
    required_fields: z.array(z.string()).default([]),
    response_time: z.string(),
  }),
  tools: z.array(z.string()).default([]),
  model: z
    .object({
      id: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    })
    .prefault({}),
  /** Linked in the first reply to a new contact. */
  privacy_policy_url: z.url().optional(),
  policies: z.record(z.string(), z.string()).default({}),
  product_data: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;
