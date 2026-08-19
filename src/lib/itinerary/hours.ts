import type { OpeningWindow } from "@/types/domain";

/** Minutes since local midnight for "HH:MM". */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) {
    throw new Error(`Malformed time: ${hhmm}`);
  }
  return hours * 60 + mins;
}

/**
 * Is the venue open for the whole window [arrival, arrival + stayMinutes)?
 *
 * Bars are the reason this is not a simple range check: a window of
 * 17:00-02:00 has close < open and belongs to the *previous* day once the
 * clock passes midnight, so a 00:30 arrival on Saturday must be tested against
 * Friday's row as well as Saturday's.
 */
export function isOpenDuring(
  hours: OpeningWindow[],
  arrival: Date,
  stayMinutes: number,
): boolean {
  if (hours.length === 0) return true; // unknown hours: don't over-filter cold-start inventory

  const day = arrival.getDay();
  const previousDay = (day + 6) % 7;
  const arrivalMinutes = arrival.getHours() * 60 + arrival.getMinutes();
  const departureMinutes = arrivalMinutes + stayMinutes;

  for (const window of hours) {
    const open = toMinutes(window.open);
    const close = toMinutes(window.close);
    const wrapsMidnight = close <= open;

    if (window.day === day && !wrapsMidnight) {
      if (arrivalMinutes >= open && departureMinutes <= close) return true;
    }

    if (window.day === day && wrapsMidnight) {
      // Evening portion: open .. midnight, spilling into tomorrow.
      if (arrivalMinutes >= open && departureMinutes <= close + 24 * 60) return true;
    }

    if (window.day === previousDay && wrapsMidnight) {
      // Small-hours portion of yesterday's window.
      if (arrivalMinutes < close && departureMinutes <= close) return true;
    }
  }

  return false;
}
