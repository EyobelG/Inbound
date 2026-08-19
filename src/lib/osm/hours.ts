import type { OpeningWindow } from "@/types/domain";

/**
 * Parses the subset of OSM `opening_hours` we can trust.
 *
 * The full grammar supports holidays, seasons, sunset offsets, and week
 * numbers. Rather than half-implement that, this handles the common weekday
 * and time-range forms and returns `[]` for anything it does not fully
 * understand. Empty is the safe answer: `isOpenDuring` treats unknown hours as
 * open, so a venue is never wrongly filtered out by a parse we got wrong.
 */
const DAY_INDEX: Record<string, number> = {
  su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
};

const TIME = /^([0-3]?\d):([0-5]\d)$/;

function expandDays(spec: string): number[] | null {
  const days = new Set<number>();

  for (const part of spec.split(",")) {
    const range = part.trim().toLowerCase();
    if (!range) continue;

    const [fromRaw, toRaw] = range.split("-");
    const from = DAY_INDEX[(fromRaw ?? "").slice(0, 2)];
    if (from === undefined) return null;

    if (toRaw === undefined) {
      days.add(from);
      continue;
    }

    const to = DAY_INDEX[toRaw.slice(0, 2)];
    if (to === undefined) return null;

    // Ranges wrap: "Fr-Mo" means Fri, Sat, Sun, Mon.
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }

  return days.size > 0 ? [...days] : null;
}

function normalizeTime(value: string): string | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  // OSM writes past-midnight closes as 24:00-30:00; fold them back onto a 24h
  // clock, which is exactly the wrap `isOpenDuring` already handles.
  const folded = hour >= 24 ? hour - 24 : hour;
  if (folded > 23) return null;
  return `${String(folded).padStart(2, "0")}:${match[2]}`;
}

export function parseOsmOpeningHours(raw: string | undefined): OpeningWindow[] {
  if (!raw) return [];

  const value = raw.trim();
  if (value === "24/7") {
    return Array.from({ length: 7 }, (_, day) => ({
      day, open: "00:00", close: "23:59",
    }));
  }

  const windows: OpeningWindow[] = [];

  for (const rule of value.split(";")) {
    const text = rule.trim();
    if (!text) continue;
    // Anything carrying these markers needs the real grammar; bail on the lot
    // rather than silently dropping a condition.
    if (/off|closed|PH|SH|sunset|sunrise|week|easter|\[/i.test(text)) return [];

    const match = /^([A-Za-z,\-\s]+?)\s+([\d:,\-\s]+)$/.exec(text);
    if (!match) return [];

    const days = expandDays(match[1]!);
    if (!days) return [];

    for (const span of match[2]!.split(",")) {
      const [openRaw, closeRaw] = span.trim().split("-");
      if (!openRaw || !closeRaw) return [];

      const open = normalizeTime(openRaw);
      const close = normalizeTime(closeRaw);
      if (!open || !close) return [];

      for (const day of days) windows.push({ day, open, close });
    }
  }

  return windows;
}
