"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { StationCombobox } from "@/components/StationCombobox";
import type { DateStage, Station, VibePriority } from "@/types/domain";

export interface PlannerSelection {
  stationA: Station;
  stationB: Station;
  dateStage: DateStage;
  vibePriority: VibePriority;
}

export interface MidpointPlannerBarProps {
  stations: Station[];
  onGenerate: (selection: PlannerSelection) => void | Promise<void>;
  isGenerating?: boolean;
  error?: string | null;
  className?: string;
}

const STAGE_CHIPS: Array<{ value: DateStage; label: string }> = [
  { value: "first_date", label: "1st Date" },
  { value: "second_or_third", label: "3rd Date" },
  { value: "established_exclusive", label: "Regular" },
  { value: "anniversary", label: "Special Occasion" },
];

const VIBE_CHIPS: Array<{ value: VibePriority; label: string }> = [
  { value: "quiet_convo", label: "Quiet Convo" },
  { value: "fun_activity", label: "Fun Activity" },
  { value: "romantic_dim", label: "Romantic / Dim" },
];

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

export function MidpointPlannerBar({
  stations,
  onGenerate,
  isGenerating = false,
  error = null,
  className,
}: MidpointPlannerBarProps) {
  const [stationA, setStationA] = useState<Station | null>(null);
  const [stationB, setStationB] = useState<Station | null>(null);
  const [dateStage, setDateStage] = useState<DateStage>("first_date");
  const [vibePriority, setVibePriority] = useState<VibePriority>("quiet_convo");

  const ready = stationA !== null && stationB !== null && !isGenerating;

  const submit = () => {
    if (!stationA || !stationB) return;
    void onGenerate({ stationA, stationB, dateStage, vibePriority });
  };

  return (
    <section
      className={cn(
        "space-y-4 rounded-lg border border-border bg-card/80 p-4 backdrop-blur",
        className,
      )}
      aria-label="Date planner"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <StationCombobox
          stations={stations}
          value={stationA}
          onChange={setStationA}
          label="You're coming from"
          excludeStationId={stationB?.gtfsStopId ?? null}
        />
        <ArrowRight className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground sm:block" />
        <StationCombobox
          stations={stations}
          value={stationB}
          onChange={setStationB}
          label="They're coming from"
          excludeStationId={stationA?.gtfsStopId ?? null}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">Date stage</legend>
        <div className="flex flex-wrap gap-2">
          {STAGE_CHIPS.map((chip) => (
            <Chip
              key={chip.value}
              selected={dateStage === chip.value}
              onClick={() => setDateStage(chip.value)}
            >
              {chip.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">Vibe priority</legend>
        <div className="flex flex-wrap gap-2">
          {VIBE_CHIPS.map((chip) => (
            <Chip
              key={chip.value}
              selected={vibePriority === chip.value}
              onClick={() => setVibePriority(chip.value)}
            >
              {chip.label}
            </Chip>
          ))}
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}

      <motion.button
        type="button"
        onClick={submit}
        disabled={!ready}
        whileTap={ready ? { scale: 0.98 } : undefined}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-opacity",
          ready
            ? "bg-primary text-primary-foreground hover:opacity-90"
            : "cursor-not-allowed bg-muted text-muted-foreground",
        )}
      >
        {isGenerating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Finding your midpoint…
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" />
            Generate Itinerary
          </>
        )}
      </motion.button>
    </section>
  );
}

export default MidpointPlannerBar;
