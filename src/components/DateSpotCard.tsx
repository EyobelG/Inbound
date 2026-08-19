"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Footprints,
  Lightbulb,
  Plus,
  Quote,
  Volume2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateStage, Spot } from "@/types/domain";

export interface DateSpotCardProps {
  spot: Spot;
  /** Highlights the badge matching the stage the planner is filtering on. */
  activeStage?: DateStage;
  onAddToRoute?: (spot: Spot) => void;
  className?: string;
}

const STAGE_BADGE: Record<DateStage, string> = {
  first_date: "1st Date Certified",
  second_or_third: "3rd Date Ready",
  established_exclusive: "Regular Spot",
  anniversary: "Special Occasion",
};

/** The stage with the most votes, but only once the sample means something. */
function topStage(spot: Spot): { stage: DateStage; share: number } | null {
  const votes = spot.vibes?.bestForStage;
  if (!votes) return null;
  const total = Object.values(votes).reduce((sum, n) => sum + n, 0);
  if (total < 3) return null;

  const [stage, count] = Object.entries(votes).sort(([, a], [, b]) => b - a)[0] as [
    DateStage,
    number,
  ];
  return { stage, share: count / total };
}

/** Semi-circular gauge: 1.0 sweeps to the left, 5.0 to the right. */
function VibeGauge({
  label,
  value,
  lowLabel,
  highLabel,
  icon,
}: {
  label: string;
  value: number | null;
  lowLabel: string;
  highLabel: string;
  icon: React.ReactNode;
}) {
  if (value == null) {
    return (
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className="text-xs italic text-muted-foreground">Not yet rated</p>
      </div>
    );
  }

  const fraction = (value - 1) / 4; // 1..5 -> 0..1

  return (
    <div className="flex-1 space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-medium tabular-nums">{value.toFixed(1)}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={1}
        aria-valuemax={5}
        aria-label={`${label}: ${value.toFixed(1)} out of 5`}
      >
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={{ width: 0 }}
          animate={{ width: `${fraction * 100}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

function Badge({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "accent" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium backdrop-blur",
        tone === "accent"
          ? "bg-primary/90 text-primary-foreground"
          : "bg-black/60 text-white",
      )}
    >
      {children}
    </span>
  );
}

export function DateSpotCard({ spot, activeStage, onAddToRoute, className }: DateSpotCardProps) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(0);

  const photos = spot.photos;
  const hasPhotos = photos.length > 0;

  const paginate = useCallback(
    (delta: number) => {
      if (photos.length < 2) return;
      setDirection(delta);
      setIndex((current) => (current + delta + photos.length) % photos.length);
    },
    [photos.length],
  );

  const stage = topStage(spot);
  const isQuiet = (spot.vibes?.avgNoiseLevel ?? 5) <= 2.5;
  const walkMinutes = spot.walkingMinutes ?? spot.walkingMinutesToT;

  return (
    <article
      className={cn(
        "group overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-shadow hover:shadow-md",
        className,
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {hasPhotos ? (
          <AnimatePresence initial={false} custom={direction} mode="popLayout">
            <motion.div
              key={photos[index]!.id}
              custom={direction}
              initial={{ opacity: 0, x: direction > 0 ? 40 : -40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction > 0 ? -40 : 40 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.15}
              onDragEnd={(_, info) => {
                if (info.offset.x < -60) paginate(1);
                else if (info.offset.x > 60) paginate(-1);
              }}
              className="absolute inset-0"
            >
              <Image
                src={photos[index]!.url}
                alt={photos[index]!.caption ?? `${spot.name} interior`}
                fill
                sizes="(max-width: 768px) 100vw, 360px"
                className="object-cover"
                priority={index === 0}
              />
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No photos yet
          </div>
        )}

        <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1">
          {stage && (
            <Badge tone={stage.stage === activeStage ? "accent" : "default"}>
              {STAGE_BADGE[stage.stage]}
            </Badge>
          )}
          {isQuiet && spot.vibes?.avgNoiseLevel != null && <Badge>Low Noise</Badge>}
          {walkMinutes != null && <Badge>{`T: ${walkMinutes} min walk`}</Badge>}
        </div>

        {photos.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous photo"
              onClick={() => paginate(-1)}
              className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next photo"
              onClick={() => paginate(1)}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
              {photos.map((photo, i) => (
                <span
                  key={photo.id}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === index ? "w-4 bg-white" : "w-1.5 bg-white/50",
                  )}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="space-y-3 p-3">
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{spot.name}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {spot.neighborhood} · {spot.priceTier}
            </p>
          </div>
          {onAddToRoute && (
            <button
              type="button"
              onClick={() => onAddToRoute(spot)}
              className="shrink-0 rounded-md border border-border p-1.5 transition-colors hover:bg-muted"
              aria-label={`Add ${spot.name} to route`}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </header>

        <div className="flex gap-4">
          <VibeGauge
            label="Noise"
            value={spot.vibes?.avgNoiseLevel ?? null}
            lowLabel="Whisper"
            highLabel="Shouting"
            icon={<Volume2 className="h-3 w-3" />}
          />
          <VibeGauge
            label="Lighting"
            value={spot.vibes?.lightingScore ?? null}
            lowLabel="Candlelit"
            highLabel="Daylight"
            icon={<Lightbulb className="h-3 w-3" />}
          />
        </div>

        {spot.topQuote && (
          <blockquote className="rounded-md bg-muted p-2 text-xs leading-relaxed text-muted-foreground">
            <Quote className="mb-1 h-3 w-3 opacity-60" />
            <p className="line-clamp-3">{spot.topQuote.body}</p>
            <footer className="mt-1 text-[10px] opacity-70">
              {spot.topQuote.helpfulCount} found this helpful
            </footer>
          </blockquote>
        )}

        {spot.distanceMeters != null && (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Footprints className="h-3 w-3" />
            {Math.round(spot.distanceMeters)}m from the meeting point
          </p>
        )}
      </div>
    </article>
  );
}

export default DateSpotCard;
