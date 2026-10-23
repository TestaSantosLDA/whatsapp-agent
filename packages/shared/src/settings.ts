/**
 * Client settings the team edits in the dashboard (WA-022). They are stored in the database as
 * overrides on top of clients/<id>.yaml: only the values that differ from the file are kept, so a
 * later change to the file still applies to everything the team has not touched.
 */
import { z } from 'zod';
import { weekdaySchema, type ClientConfig, type Weekday } from './client-config.js';

const weekdays = weekdaySchema.options;

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "08:00-13:00": a valid time of day on both sides, and the end after the start. */
export const settingsTimeRangeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/, 'use HH:MM-HH:MM')
  .refine(
    (r) => toMinutes(r.slice(0, 5)) < toMinutes(r.slice(6)),
    'the end must be after the start',
  );

export const settingsHoursSchema = z.partialRecord(
  weekdaySchema,
  z.array(settingsTimeRangeSchema).max(4),
);
export type SettingsHours = z.infer<typeof settingsHoursSchema>;

export const branchSettingsSchema = z.object({
  id: z.string(),
  /** Who receives this branch's leads, handoffs and order drafts. */
  lead_emails: z.array(z.email()).max(20),
  hours: settingsHoursSchema,
});
export type BranchSettings = z.infer<typeof branchSettingsSchema>;

/** The editable view of a client's settings: what the Settings screen loads and saves. */
export const clientSettingsSchema = z.object({
  response_time: z.string().trim().min(1).max(80),
  response_time_hours: z.number().positive().max(200).nullable(),
  handoff_triggers: z.array(z.string().trim().min(1).max(300)).max(30),
  branches: z.array(branchSettingsSchema),
});
export type ClientSettings = z.infer<typeof clientSettingsSchema>;

/** What is stored per client (`client_settings.overrides`): only the values that differ. */
export const clientSettingsOverridesSchema = z.object({
  response_time: clientSettingsSchema.shape.response_time.optional(),
  response_time_hours: z.number().positive().max(200).optional(),
  handoff_triggers: clientSettingsSchema.shape.handoff_triggers.optional(),
  branches: z
    .record(
      z.string(),
      z.object({
        lead_emails: branchSettingsSchema.shape.lead_emails.optional(),
        hours: settingsHoursSchema.optional(),
      }),
    )
    .optional(),
});
export type ClientSettingsOverrides = z.infer<typeof clientSettingsOverridesSchema>;

/** Weekdays in order, closed days (no ranges) left out, so equal hours compare equal. */
export function normaliseHours(hours: SettingsHours): SettingsHours {
  const out: SettingsHours = {};
  for (const day of weekdays) {
    const ranges = (hours[day] ?? []).map((r) => r.trim()).filter(Boolean);
    if (ranges.length) out[day as Weekday] = ranges;
  }
  return out;
}

/** The editable settings of a (merged or file) client config. */
export function clientSettingsOf(config: ClientConfig): ClientSettings {
  return {
    response_time: config.lead.response_time,
    response_time_hours: config.lead.response_time_hours ?? null,
    handoff_triggers: [...config.handoff.triggers],
    branches: config.branches.map((b) => ({
      id: b.id,
      lead_emails: [...b.lead_emails],
      hours: normaliseHours(b.hours),
    })),
  };
}

/**
 * The config with the overrides applied. Overrides for branches the file no longer has are
 * ignored, so removing a branch from the YAML never stops the service from starting.
 */
export function applyClientSettings(
  config: ClientConfig,
  overrides: ClientSettingsOverrides,
): ClientConfig {
  return {
    ...config,
    lead: {
      ...config.lead,
      ...(overrides.response_time !== undefined && { response_time: overrides.response_time }),
      ...(overrides.response_time_hours !== undefined && {
        response_time_hours: overrides.response_time_hours,
      }),
    },
    handoff: {
      ...config.handoff,
      ...(overrides.handoff_triggers !== undefined && { triggers: overrides.handoff_triggers }),
    },
    branches: config.branches.map((branch) => {
      const o = overrides.branches?.[branch.id];
      if (!o) return branch;
      return {
        ...branch,
        ...(o.lead_emails !== undefined && { lead_emails: o.lead_emails }),
        ...(o.hours !== undefined && { hours: normaliseHours(o.hours) }),
      };
    }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The overrides that turn `base` (the YAML config) into `edited`: only what differs. */
export function diffClientSettings(
  base: ClientConfig,
  edited: ClientSettings,
): ClientSettingsOverrides {
  const from = clientSettingsOf(base);
  const out: ClientSettingsOverrides = {};
  if (edited.response_time !== from.response_time) out.response_time = edited.response_time;
  if (
    edited.response_time_hours !== null &&
    edited.response_time_hours !== from.response_time_hours
  )
    out.response_time_hours = edited.response_time_hours;
  if (!same(edited.handoff_triggers, from.handoff_triggers))
    out.handoff_triggers = edited.handoff_triggers;
  for (const branch of edited.branches) {
    const was = from.branches.find((b) => b.id === branch.id);
    if (!was) continue;
    const o: NonNullable<ClientSettingsOverrides['branches']>[string] = {};
    if (!same(branch.lead_emails, was.lead_emails)) o.lead_emails = branch.lead_emails;
    const hours = normaliseHours(branch.hours);
    if (!same(hours, was.hours)) o.hours = hours;
    if (Object.keys(o).length) (out.branches ??= {})[branch.id] = o;
  }
  return out;
}

/** Paths that are overridden, e.g. `response_time`, `branches.maia.lead_emails`. */
export function overriddenPaths(overrides: ClientSettingsOverrides): string[] {
  const paths = (['response_time', 'response_time_hours', 'handoff_triggers'] as const).filter(
    (k) => overrides[k] !== undefined,
  ) as string[];
  for (const [id, o] of Object.entries(overrides.branches ?? {})) {
    for (const key of Object.keys(o)) paths.push(`branches.${id}.${key}`);
  }
  return paths;
}
