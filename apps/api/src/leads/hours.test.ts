import { describe, expect, it } from 'vitest';
import { workingHoursBetween } from '../agent/hours.js';

const TZ = 'Europe/Lisbon';
const weekday = ['09:00-13:00', '14:00-18:00'];
/** Mon–Fri 9–13 and 14–18 (8 h a day), closed at the weekend. */
const office = { hours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday } };
/** The same, plus Saturday morning. */
const withSaturday = { hours: { ...office.hours, sat: ['09:00-13:00'] } };

/** Lisbon wall-clock time; October 2026 before the 25th is summer time (UTC+1). */
const at = (iso: string, offset = '+01:00') => new Date(`${iso}${offset}`);
const hours = (branch: { hours: Record<string, string[]> }, from: Date, to: Date) =>
  workingHoursBetween(branch, from, to, TZ);

describe('workingHoursBetween', () => {
  it('counts only opening hours, skipping the lunch break', () => {
    expect(hours(office, at('2026-10-06T12:00'), at('2026-10-06T15:00'))).toBe(2);
    expect(hours(office, at('2026-10-06T13:10'), at('2026-10-06T13:50'))).toBe(0);
    expect(hours(office, at('2026-10-06T07:00'), at('2026-10-06T20:00'))).toBe(8);
    expect(hours(office, at('2026-10-06T08:00'), at('2026-10-06T09:30'))).toBe(0.5);
  });

  it('is zero for an empty or reversed interval', () => {
    expect(hours(office, at('2026-10-06T10:00'), at('2026-10-06T10:00'))).toBe(0);
    expect(hours(office, at('2026-10-06T11:00'), at('2026-10-06T10:00'))).toBe(0);
  });

  it('skips closed days: a lead from Friday 17:30 reaches 8 h on Monday at 17:30', () => {
    const friday = at('2026-10-09T17:30');
    expect(hours(office, friday, at('2026-10-11T23:59'))).toBe(0.5);
    expect(hours(office, friday, at('2026-10-12T13:00'))).toBe(4.5);
    expect(hours(office, friday, at('2026-10-12T17:29'))).toBeCloseTo(7.983, 3);
    expect(hours(office, friday, at('2026-10-12T17:30'))).toBe(8);
  });

  it('counts Saturday hours where the branch opens on Saturday', () => {
    const friday = at('2026-10-09T17:30');
    expect(hours(withSaturday, friday, at('2026-10-10T13:00'))).toBe(4.5);
    // 0.5 Friday + 4 Saturday + 3.5 on Monday morning.
    expect(hours(withSaturday, friday, at('2026-10-12T12:30'))).toBe(8);
  });

  it('starts the clock at the next opening for a lead sent when closed', () => {
    const sunday = at('2026-10-11T22:00');
    expect(hours(office, sunday, at('2026-10-12T09:00'))).toBe(0);
    expect(hours(office, sunday, at('2026-10-12T10:15'))).toBe(1.25);
  });

  it('follows the wall clock across a DST change', () => {
    // Summer time ends on Sunday 25 October 2026: Friday is UTC+1, Monday UTC+0.
    const friday = at('2026-10-23T17:00');
    expect(hours(office, friday, at('2026-10-26T10:00', '+00:00'))).toBe(2);
    expect(hours(office, friday, at('2026-10-26T18:00', '+00:00'))).toBe(9);
    // Summer time starts on Sunday 29 March 2026: Friday is UTC+0, Monday UTC+1.
    expect(hours(office, at('2026-03-27T17:00', '+00:00'), at('2026-03-30T10:00'))).toBe(2);
    // A branch open on the Sunday itself, after the change.
    const sundays = { hours: { sun: ['09:00-13:00'] } };
    expect(hours(sundays, at('2026-10-24T00:00'), at('2026-10-26T00:00', '+00:00'))).toBe(4);
  });

  it('spans weeks', () => {
    expect(hours(office, at('2026-10-05T09:00'), at('2026-10-17T09:00'))).toBe(80);
  });
});
