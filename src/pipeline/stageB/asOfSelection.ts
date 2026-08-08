const DAY_MS = 86_400_000;

/** Parse one exact, real Gregorian YYYY-MM-DD as a UTC-midnight epoch. */
function strictUtcDayMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  if (day > monthDays[month - 1]) return null;

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getTime();
}

/**
 * Select the latest strictly dated row on or before `asOf`, provided it is no
 * more than `maxAgeDays` old. Input order is preserved for same-date ties.
 * Invalid dates and invalid/overflowing tolerances fail closed; rows are never
 * inspected beyond their date and the input collection is never mutated.
 */
export function latestOnOrBeforeWithin<T extends { date: string }>(
  rows: readonly T[],
  asOf: string,
  maxAgeDays: number,
): T | null {
  const asOfMs = strictUtcDayMs(asOf);
  if (asOfMs === null) return null;
  if (
    !Number.isSafeInteger(maxAgeDays) ||
    maxAgeDays < 0 ||
    maxAgeDays > Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS)
  ) {
    return null;
  }

  const maxAgeMs = maxAgeDays * DAY_MS;
  let selected: T | null = null;
  let selectedMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rowMs = strictUtcDayMs(row.date);
    if (rowMs === null || rowMs > asOfMs) continue;
    const ageMs = asOfMs - rowMs;
    if (ageMs > maxAgeMs) continue;
    if (rowMs > selectedMs) {
      selected = row;
      selectedMs = rowMs;
    }
  }
  return selected;
}
