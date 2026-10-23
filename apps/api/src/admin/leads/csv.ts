/**
 * CSV for Excel in Portugal (WA-024): UTF-8 with a BOM (so accents survive), `;` between fields
 * (pt-PT Excel uses the comma for decimals) and CRLF line ends.
 */

const BOM = '﻿';

/**
 * One field. Quoted when it holds `;`, `"` or a line break. A leading `=`, `+`, `-`, `@`, tab or
 * CR would make a spreadsheet read a formula (CSV injection), so such a field gets a `'` first.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return BOM + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/**
 * A phone number as the team dials it: Portuguese numbers in the national format
 * ("912 345 678", which Excel keeps as it is), others as +<digits>.
 */
export function csvPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('351')) {
    const n = digits.slice(3);
    return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  return `+${digits}`;
}

/** "23/10/2026 14:05" in the client's time zone. */
export function csvDate(value: Date | null | undefined, timeZone: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(value)
    .replace(',', '');
}
