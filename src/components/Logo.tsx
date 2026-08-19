import { MBTA_LINE_COLORS } from "@/lib/mbta/colors";
import { cn } from "@/lib/utils";

/**
 * The mark is the product: two transit lines arriving from different
 * directions and converging on one meeting point, then continuing together.
 *
 * Red and green are the real MBTA line colors rather than invented brand
 * colors, so the mark is legible to anyone who rides the T - and it reads from
 * the same tokens the map polylines do, so the two can never drift apart.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[10px] bg-gradient-to-br from-primary to-violet-700 shadow-sm",
        "h-9 w-9",
        className,
      )}
    >
      <svg
        viewBox="0 0 32 32"
        className="h-6 w-6"
        role="img"
        aria-label="Inbound"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Two inbound routes, easing toward the hub so the eye lands on the
            convergence rather than on the line ends. */}
        <path d="M2 6 C 2 6, 10 6, 14 12" stroke={MBTA_LINE_COLORS.red} strokeWidth="3.5" strokeLinecap="round" />
        <path d="M2 26 C 2 26, 10 26, 14 20" stroke={MBTA_LINE_COLORS.green_c} strokeWidth="3.5" strokeLinecap="round" />
        {/* The onward journey: one shared line leaving together. */}
        <path d="M19 16 H30" stroke="white" strokeWidth="3.5" strokeLinecap="round" opacity="0.95" />
        {/* The meeting point, punched out of the lines. */}
        <circle cx="16" cy="16" r="6.5" fill="url(#logo-hub)" />
        <circle cx="16" cy="16" r="4" fill="white" />
        <defs>
          <linearGradient id="logo-hub" x1="10" y1="10" x2="22" y2="22">
            <stop stopColor="#7C3AED" />
            <stop offset="1" stopColor="#6D28D9" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}
