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
  /** Who receives this branch's leads, handoffs and order drafts. Empty = the branch `email`. */
  lead_emails: z.array(z.string()).default([]),
});
export type Branch = z.infer<typeof branchSchema>;

/** A question the agent asks before saving the lead; the answer is stored under `id`. */
export const skillLeadFieldSchema = z.object({
  id: z.string(),
  ask: z.string(),
  required: z.boolean().default(false),
});

/**
 * A client-specific playbook (WA-017): when it applies, what the agent knows and how it guides
 * the conversation, and which lead fields it collects before calling save_lead.
 */
export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The business line its leads are routed by. */
  business_line: z.string().optional(),
  /** When the agent should use it, in plain words. */
  when: z.string(),
  instructions: z.string(),
  lead_type: z.string().default('quote'),
  lead_fields: z.array(skillLeadFieldSchema).default([]),
});
export type Skill = z.infer<typeof skillSchema>;

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

/**
 * Lead fields the agent can collect with save_lead (WA-014). `lead.required_fields` names a
 * subset; the phone is always known from WhatsApp.
 */
export const leadFieldSchema = z.enum([
  'name',
  'email',
  'location',
  'request_type',
  'business_line',
  'products',
  'area_m2',
  'timeline',
]);
export type LeadField = z.infer<typeof leadFieldSchema>;

/** Keys a lead always has; a skill's lead fields must use other ids so they never replace them. */
export const coreLeadKeys: readonly string[] = [
  ...leadFieldSchema.options,
  'phone',
  'summary',
  'attachments',
];

/** Where leads go besides the database, which is always on. */
export const leadSinkSchema = z.enum(['db', 'sheets']);
export type LeadSinkName = z.infer<typeof leadSinkSchema>;

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
    required_fields: z.array(leadFieldSchema).default([]),
    /** What the customer is told, e.g. "um dia útil". Editable in the dashboard (WA-022). */
    response_time: z.string(),
    /** The same promise in working hours, for no-reply alerts (WA-024). Empty = 8 (one day). */
    response_time_hours: z.number().positive().max(200).optional(),
    /** Extra sinks; `db` is always written whether listed or not. */
    sinks: z.array(leadSinkSchema).default(['db']),
    /** Google Sheet the `sheets` sink appends to (service account from the environment). */
    sheets: z
      .object({ spreadsheet_id: z.string().min(1), sheet_name: z.string().default('Leads') })
      .optional(),
    /** Branch whose team receives order drafts for delivery. Default: routing.default_branch. */
    order_branch: z.string().optional(),
  }),
  /** Business emails (WA-015). `from` must be a sender the mail provider accepts. */
  mail: z
    .object({
      from: z.string().default('Assistente WhatsApp <noreply@example.invalid>'),
      reply_to: z.string().optional(),
    })
    .prefault({}),
  /** Extra situations, beyond the built-in ones, in which the agent hands over to a person. */
  handoff: z.object({ triggers: z.array(z.string()).default([]) }).prefault({}),
  tools: z.array(z.string()).default([]),
  model: z
    .object({
      id: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    })
    .prefault({}),
  /** Linked in the first reply to a new contact. */
  privacy_policy_url: z.url().optional(),
  /** WA-028: contacts with no activity for this many months are deleted by a scheduled job. */
  privacy: z
    .object({ retention_months: z.number().int().min(1).max(120).default(24) })
    .prefault({}),
  policies: z.record(z.string(), z.string()).default({}),
  product_data: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  /** Client-specific conversation playbooks added to the system prompt (WA-017). */
  skills: z.array(skillSchema).default([]),
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;
