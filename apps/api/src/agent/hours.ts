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
