import { FormArray, FormControl, FormGroup, Validators, type ValidatorFn } from '@angular/forms';
import {
  branchSettingsSchema,
  settingsTimeRangeSchema,
  weekdaySchema,
  type ClientSettings,
  type Weekday,
} from '@wa/shared';

export const WEEKDAYS = weekdaySchema.options;

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Segunda',
  tue: 'Terça',
  wed: 'Quarta',
  thu: 'Quinta',
  fri: 'Sexta',
  sat: 'Sábado',
  sun: 'Domingo',
};

/** One value per line (commas and semicolons also separate). */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One trigger per line (triggers can contain commas). */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every address valid, using the API's own schema. */
export const emailListValidator: ValidatorFn = (control) => {
  const emails = splitList(String(control.value ?? ''));
  const bad = emails.filter((e) => !branchSettingsSchema.shape.lead_emails.safeParse([e]).success);
  return bad.length ? { emails: bad } : null;
};

/** "08:00-13:00, 14:00-18:00", or empty for closed. */
export const hoursValidator: ValidatorFn = (control) => {
  const ranges = splitList(String(control.value ?? ''));
  const bad = ranges.filter((r) => !settingsTimeRangeSchema.safeParse(r).success);
  return bad.length || ranges.length > 4 ? { hours: bad } : null;
};

export type HoursGroup = FormGroup<Record<Weekday, FormControl<string>>>;
export type BranchGroup = FormGroup<{
  id: FormControl<string>;
  lead_emails: FormControl<string>;
  hours: HoursGroup;
}>;
export type SettingsForm = FormGroup<{
  response_time: FormControl<string>;
  response_time_hours: FormControl<number | null>;
  handoff_triggers: FormControl<string>;
  branches: FormArray<BranchGroup>;
}>;

const text = (value: string, ...validators: ValidatorFn[]) =>
  new FormControl(value, { nonNullable: true, validators });

export function buildSettingsForm(settings: ClientSettings): SettingsForm {
  return new FormGroup({
    response_time: text(settings.response_time, Validators.required, Validators.maxLength(80)),
    response_time_hours: new FormControl<number | null>(settings.response_time_hours, [
      Validators.min(0.5),
      Validators.max(200),
    ]),
    handoff_triggers: text(settings.handoff_triggers.join('\n')),
    branches: new FormArray(
      settings.branches.map(
        (b): BranchGroup =>
          new FormGroup({
            id: text(b.id),
            lead_emails: text(b.lead_emails.join('\n'), emailListValidator),
            hours: new FormGroup(
              Object.fromEntries(
                WEEKDAYS.map((day) => [day, text((b.hours[day] ?? []).join(', '), hoursValidator)]),
              ) as Record<Weekday, FormControl<string>>,
            ),
          }),
      ),
    ),
  });
}

/** The form's value as the body of PUT /settings. */
export function formToSettings(form: SettingsForm): ClientSettings {
  const v = form.getRawValue();
  const hours = v.response_time_hours;
  return {
    response_time: v.response_time.trim(),
    response_time_hours: hours === null || String(hours) === '' ? null : Number(hours),
    handoff_triggers: splitLines(v.handoff_triggers),
    branches: v.branches.map((b) => ({
      id: b.id,
      lead_emails: splitList(b.lead_emails).map((e) => e.toLowerCase()),
      hours: Object.fromEntries(
        WEEKDAYS.map((day) => [day, splitList(b.hours[day])] as const).filter(([, r]) => r.length),
      ),
    })),
  };
}
