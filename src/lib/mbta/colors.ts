import type { MbtaLine } from "@/types/domain";

/**
 * Official MBTA line colors. Single source of truth: the Tailwind theme and
 * the MapLibre paint properties both read from here, so a chip and the polyline
 * it refers to can never drift apart.
 */
export const MBTA_LINE_COLORS: Record<MbtaLine, string> = {
  red: "#DA291C",
  green_b: "#00843D",
  green_c: "#00843D",
  green_d: "#00843D",
  green_e: "#00843D",
  orange: "#ED8B00",
  blue: "#003DA5",
};

export const MBTA_LINE_LABELS: Record<MbtaLine, string> = {
  red: "Red Line",
  green_b: "Green Line B",
  green_c: "Green Line C",
  green_d: "Green Line D",
  green_e: "Green Line E",
  orange: "Orange Line",
  blue: "Blue Line",
};
