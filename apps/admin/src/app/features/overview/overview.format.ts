/** Formatting for the Resumo screen (WA-029), pt-PT. */
import type { GapReason } from '@wa/shared';

/** "45 min", "2 h", "2 h 15 min", "3 d 4 h"; "—" when there is nothing to show. */
export function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const totalHours = Math.floor(minutes / 60);
  if (totalHours >= 48) {
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  const m = Math.round(minutes % 60);
  return m ? `${totalHours} h ${m} min` : `${totalHours} h`;
}

const usdFormat = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const usd = (value: number) => usdFormat.format(value);

/** "21/10", in the client's time zone (the periods start at its local midnight). */
export function shortDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', timeZone }).format(
    new Date(iso),
  );
}

/** Width of a bar, in %, for a count against the largest. */
export const barWidth = (count: number, max: number) =>
  max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;

export const reasonShort: Record<GapReason, string> = {
  deferred: 'Ficou de confirmar',
  handoff: 'Passou à equipa',
  no_result: 'Pesquisa sem resultado',
};
