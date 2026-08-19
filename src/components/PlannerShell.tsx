"use client";

import { useMemo, useState } from "react";
import { MidpointPlannerBar, type PlannerSelection } from "@/components/MidpointPlannerBar";
import { InteractiveDateMap, type RouteLeg } from "@/components/InteractiveDateMap";
import { DateSpotCard } from "@/components/DateSpotCard";
import type { DatePairing } from "@/lib/itinerary/generateTwoPartDate";
import { authedFetch } from "@/lib/firebase/client";
import type { MbtaLine, Spot, Station } from "@/types/domain";

interface GenerateResponse {
  midpoint: { station: Station; minutesFromA: number; minutesFromB: number; spreadMinutes: number };
  pairings: DatePairing[];
}

export function PlannerShell({ stations }: { stations: Station[] }) {
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [activePairing, setActivePairing] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<PlannerSelection | null>(null);

  // Station rows already arrive ordered by (line, order_index), so the polyline
  // for each line is just its coordinates in sequence.
  const lines = useMemo(() => {
    const byLine = new Map<MbtaLine, Station[]>();
    for (const station of stations) {
      const bucket = byLine.get(station.line) ?? [];
      bucket.push(station);
      byLine.set(station.line, bucket);
    }
    return [...byLine.entries()].map(([line, group]) => ({
      line,
      coordinates: group
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((s) => s.location),
    }));
  }, [stations]);

  const pairing = result?.pairings[activePairing] ?? null;

  const spots: Spot[] = pairing ? [pairing.stepOne, pairing.stepTwo] : [];
  const legs: RouteLeg[] = pairing
    ? [{ from: pairing.stepOne.location, to: pairing.stepTwo.location }]
    : [];

  const generate = async (next: PlannerSelection) => {
    setIsGenerating(true);
    setError(null);
    setSelection(next);

    try {
      // Planning works signed-out; authedFetch simply omits the header when
      // there is no current user, and the route treats that as anonymous.
      const response = await authedFetch("/api/itineraries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          station_a_id: next.stationA.id,
          station_b_id: next.stationB.id,
          date_stage: next.dateStage,
          vibe_priority: next.vibePriority,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not build an itinerary.");
        setResult(null);
        return;
      }

      setResult(body as GenerateResponse);
      setActivePairing(0);
    } catch {
      setError("Network error — check your connection and try again.");
      setResult(null);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <div className="space-y-4">
        <MidpointPlannerBar
          stations={stations}
          onGenerate={generate}
          isGenerating={isGenerating}
          error={error}
        />

        {result && (
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">
              Meet at {result.midpoint.station.stopName}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {result.midpoint.minutesFromA} min for you, {result.midpoint.minutesFromB} min
              for them — a {result.midpoint.spreadMinutes} min difference.
            </p>
          </section>
        )}

        {pairing && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">
              Step 1 · {pairing.stepOne.name}
            </h2>
            <DateSpotCard spot={pairing.stepOne} activeStage={selection?.dateStage} />
            <p className="px-1 text-xs text-muted-foreground">↓ {pairing.transitNote}</p>
            <h2 className="text-sm font-semibold">
              Step 2 · {pairing.stepTwo.name}
            </h2>
            <DateSpotCard spot={pairing.stepTwo} activeStage={selection?.dateStage} />
          </section>
        )}

        {result && result.pairings.length > 1 && (
          <nav className="flex flex-wrap gap-2" aria-label="Other itineraries">
            {result.pairings.map((option, i) => (
              <button
                key={`${option.stepOne.id}-${option.stepTwo.id}`}
                type="button"
                onClick={() => setActivePairing(i)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  i === activePairing
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                Option {i + 1}
              </button>
            ))}
          </nav>
        )}
      </div>

      <div className="h-[70vh] min-h-96 lg:h-[calc(100dvh-8rem)]">
        <InteractiveDateMap
          lines={lines}
          spots={spots}
          meetingStation={result?.midpoint.station ?? null}
          activeLegs={legs}
          selectedSpotIds={spots.map((s) => s.id)}
          className="h-full"
        />
      </div>
    </div>
  );
}
