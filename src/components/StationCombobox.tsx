"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, MapPin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MBTA_LINE_COLORS, MBTA_LINE_LABELS } from "@/lib/mbta/colors";
import type { Station } from "@/types/domain";

export interface StationComboboxProps {
  stations: Station[];
  value: Station | null;
  onChange: (station: Station | null) => void;
  label: string;
  placeholder?: string;
  /** Prevents both sides of the planner from selecting the same station. */
  excludeStationId?: string | null;
}

/**
 * Accessible combobox over the full subway station list. Filtering is local -
 * the whole network is ~150 rows, so a network round trip per keystroke would
 * be slower and worse offline than just shipping the list.
 */
export function StationCombobox({
  stations,
  value,
  onChange,
  label,
  placeholder = "Search stations…",
  excludeStationId,
}: StationComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Collapse line-platforms into one row per physical station: a rider picking
  // "Park Street" does not care which platform the router starts from.
  const options = useMemo(() => {
    const byStation = new Map<string, { station: Station; lines: Station["line"][] }>();
    for (const station of stations) {
      if (station.gtfsStopId === excludeStationId) continue;
      const existing = byStation.get(station.gtfsStopId);
      if (existing) existing.lines.push(station.line);
      else byStation.set(station.gtfsStopId, { station, lines: [station.line] });
    }

    const needle = query.trim().toLowerCase();
    return [...byStation.values()]
      .filter((o) => !needle || o.station.stopName.toLowerCase().includes(needle))
      .sort((a, b) => a.station.stopName.localeCompare(b.station.stopName))
      .slice(0, 40);
  }, [stations, query, excludeStationId]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const select = (station: Station) => {
    onChange(station);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>

      {value ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: MBTA_LINE_COLORS[value.line] }}
          />
          <span className="min-w-0 flex-1 truncate text-sm">{value.stopName}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Clear ${label}`}
            className="rounded p-0.5 hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            value={query}
            placeholder={placeholder}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActiveIndex((i) => Math.min(i + 1, options.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter") {
                const option = options[activeIndex];
                if (option) {
                  event.preventDefault();
                  select(option.station);
                }
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-8 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      )}

      {open && !value && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {options.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No stations match.</li>
          )}
          {options.map((option, i) => (
            <li key={option.station.gtfsStopId}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(option.station)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  i === activeIndex && "bg-muted",
                )}
              >
                <span className="flex shrink-0 gap-0.5">
                  {[...new Set(option.lines)].map((line) => (
                    <span
                      key={line}
                      title={MBTA_LINE_LABELS[line]}
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: MBTA_LINE_COLORS[line] }}
                    />
                  ))}
                </span>
                <span className="truncate">{option.station.stopName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
