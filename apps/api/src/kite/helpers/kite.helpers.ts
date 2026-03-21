/**
 * kite.helpers.ts
 *
 * Pure utility functions for the Kite module.
 * No dependencies on NestJS, Prisma, or any service.
 */

/**
 * Parses a time string like "09:40 am" or "02:30 pm" to minutes since midnight.
 * Used for sorting signals chronologically.
 */
export function parseTimeToMinutes(timeStr: string): number {
  try {
    const [time, period] = timeStr.toLowerCase().split(' ');
    const [hoursStr, minutesStr] = time.split(':');

    let hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);

    if (period === 'pm' && hours !== 12) hours += 12;
    else if (period === 'am' && hours === 12) hours = 0;

    return hours * 60 + minutes;
  } catch {
    console.warn(`[kite.helpers] Failed to parse time string: ${timeStr}`);
    return 0;
  }
}

/**
 * Combines a date string (YYYY-MM-DD) and a time string ("10:25 am") into a Date object.
 */
export function parseSignalTimeToDate(dateStr: string, timeStr: string): Date {
  try {
    const [time, period] = timeStr.toLowerCase().split(' ');
    const [hoursStr, minutesStr] = time.split(':');

    let hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10);

    if (period === 'pm' && hours !== 12) hours += 12;
    else if (period === 'am' && hours === 12) hours = 0;

    const date = new Date(dateStr);
    date.setHours(hours, minutes, 0, 0);
    return date;
  } catch {
    console.warn(
      `[kite.helpers] Failed to parse signal time: ${dateStr} ${timeStr}`,
    );
    return new Date();
  }
}
