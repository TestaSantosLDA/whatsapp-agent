import type { ClientConfig } from '@wa/shared';

type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/** Local weekday and minutes since midnight of `now` in a time zone. */
export function localTime(now: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday').toLowerCase().slice(0, 3) as Weekday;
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** Whether a branch is open at `now`, in the client's time zone. */
export function isOpen(
  branch: ClientConfig['branches'][number],
  now: Date,
  timeZone: string,
): boolean {
  const { weekday, minutes } = localTime(now, timeZone);
  return (branch.hours[weekday] ?? []).some((range) => {
    const [from, to] = range.split('-');
    return minutes >= toMinutes(from!) && minutes < toMinutes(to!);
  });
}

/** "terça-feira, 21/10/2026 15:04" style local timestamp for the prompt. */
export function formatLocal(now: Date, timeZone: string, language: string): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'pt-PT', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

const weekdays: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Local calendar date of `now` in a time zone. */
function localDate(now: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The instant of a local wall-clock time in a time zone. */
function zonedInstant(
  date: { year: number; month: number; day: number },
  minutes: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  // Shift by the zone's offset at the guess, then once more at the result (DST changes).
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const local = localDate(new Date(instant), timeZone);
    const shown = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      0,
      localTime(new Date(instant), timeZone).minutes,
    );
    instant += wall - shown;
  }
  return new Date(instant);
}

export interface Opening {
  at: Date;
  weekday: Weekday;
  /** Local "HH:MM". */
  time: string;
  /** Days from today in the client's time zone: 0 today, 1 tomorrow. */
  inDays: number;
}

/**
 * When the branch next opens after `now` (WA-016), looking a week ahead. Undefined when it is
 * open now or has no opening hours at all.
 */
export function nextOpening(
  branch: Pick<ClientConfig['branches'][number], 'hours'>,
  now: Date,
  timeZone: string,
): Opening | undefined {
  if (isOpen(branch as ClientConfig['branches'][number], now, timeZone)) return undefined;
  const today = localDate(now, timeZone);
  const nowMinutes = localTime(now, timeZone).minutes;
  for (let inDays = 0; inDays <= 7; inDays++) {
    // Calendar arithmetic in UTC, so a DST change never skips or repeats a day.
    const civil = new Date(Date.UTC(today.year, today.month - 1, today.day + inDays));
    const weekday = weekdays[civil.getUTCDay()]!;
    const start = (branch.hours[weekday] ?? [])
      .map((range) => toMinutes(range.split('-')[0]!))
      .filter((m) => inDays > 0 || m > nowMinutes)
      .sort((a, b) => a - b)[0];
    if (start === undefined) continue;
    const date = {
      year: civil.getUTCFullYear(),
      month: civil.getUTCMonth() + 1,
      day: civil.getUTCDate(),
    };
    const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    return { at: zonedInstant(date, start, timeZone), weekday, time, inDays };
  }
  return undefined;
}
