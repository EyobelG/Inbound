"use client";

import { useCallback, useMemo, useState } from "react";
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Popup,
  Source,
} from "react-map-gl";
import type { LayerProps } from "react-map-gl";
import { Plus, Volume2, Footprints } from "lucide-react";
import { MBTA_LINE_COLORS } from "@/lib/mbta/colors";
import { cn } from "@/lib/utils";
import type { LngLat, MbtaLine, Spot, Station } from "@/types/domain";
import "mapbox-gl/dist/mapbox-gl.css";

export interface RouteLeg {
  from: LngLat;
  to: LngLat;
}

export interface InteractiveDateMapProps {
  /** Ordered station geometry per line, used to draw the subway itself. */
  lines: Array<{ line: MbtaLine; coordinates: LngLat[] }>;
  spots: Spot[];
  meetingStation?: Station | null;
  /** Step 1 -> Step 2 walking legs of the active itinerary. */
  activeLegs?: RouteLeg[];
  selectedSpotIds?: string[];
  onAddToRoute?: (spot: Spot) => void;
  className?: string;
}

const BOSTON_CENTER = { longitude: -71.0857, latitude: 42.3601, zoom: 12.4 };

/**
 * Walking legs are dashed and animated so they read as "on foot" against the
 * solid subway lines. `line-dasharray` is not animatable in Mapbox GL, so the
 * motion comes from cycling a small set of dash patterns rather than from a
 * transition.
 */
const DASH_FRAMES: Array<[number, number]> = [
  [0, 4], [0.5, 3.5], [1, 3], [1.5, 2.5], [2, 2], [2.5, 1.5], [3, 1], [3.5, 0.5],
];

const walkingLayer = (dashIndex: number): LayerProps => ({
  id: "walking-legs",
  type: "line",
  paint: {
    "line-color": "#8B5CF6",
    "line-width": 3,
    "line-dasharray": DASH_FRAMES[dashIndex % DASH_FRAMES.length]!,
  },
  layout: { "line-cap": "round", "line-join": "round" },
});

const CATEGORY_GLYPH: Record<Spot["category"], string> = {
  bar: "🍸",
  cafe: "☕",
  restaurant: "🍽",
  dessert: "🍰",
  activity: "🎯",
  walk_park: "🌳",
};

export function InteractiveDateMap({
  lines,
  spots,
  meetingStation,
  activeLegs = [],
  selectedSpotIds = [],
  onAddToRoute,
  className,
}: InteractiveDateMapProps) {
  const [hovered, setHovered] = useState<Spot | null>(null);
  const [dashIndex, setDashIndex] = useState(0);

  // Drive the dash animation off the map's own render loop rather than a
  // separate interval, so it pauses when the map is idle or offscreen.
  const onRender = useCallback(() => {
    setDashIndex((i) => (i + 1) % (DASH_FRAMES.length * 6));
  }, []);

  const lineGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: lines.map((l) => ({
        type: "Feature" as const,
        properties: { line: l.line, color: MBTA_LINE_COLORS[l.line] },
        geometry: {
          type: "LineString" as const,
          coordinates: l.coordinates.map((c) => [c.lng, c.lat]),
        },
      })),
    }),
    [lines],
  );

  const walkingGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: activeLegs.map((leg) => ({
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [leg.from.lng, leg.from.lat],
            [leg.to.lng, leg.to.lat],
          ],
        },
      })),
    }),
    [activeLegs],
  );

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-border bg-muted p-8 text-sm text-muted-foreground",
          className,
        )}
      >
        Map unavailable — NEXT_PUBLIC_MAPBOX_TOKEN is not configured.
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden rounded-lg", className)}>
      <Map
        mapboxAccessToken={token}
        initialViewState={BOSTON_CENTER}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        onRender={activeLegs.length > 0 ? onRender : undefined}
        reuseMaps
      >
        <NavigationControl position="top-right" showCompass={false} />

        <Source id="mbta-lines" type="geojson" data={lineGeoJson}>
          <Layer
            id="mbta-lines-layer"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5],
              "line-opacity": 0.75,
            }}
            layout={{ "line-cap": "round", "line-join": "round" }}
          />
        </Source>

        {activeLegs.length > 0 && (
          <Source id="walking-legs-src" type="geojson" data={walkingGeoJson}>
            <Layer {...walkingLayer(dashIndex)} />
          </Source>
        )}

        {meetingStation && (
          <Marker
            longitude={meetingStation.location.lng}
            latitude={meetingStation.location.lat}
            anchor="center"
          >
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white shadow-lg"
              style={{ backgroundColor: MBTA_LINE_COLORS[meetingStation.line] }}
              title={`Meet at ${meetingStation.stopName}`}
            >
              <span className="text-[10px] font-bold text-white">T</span>
            </div>
          </Marker>
        )}

        {spots.map((spot) => {
          const isSelected = selectedSpotIds.includes(spot.id);
          const stepNumber = selectedSpotIds.indexOf(spot.id) + 1;
          return (
            <Marker
              key={spot.id}
              longitude={spot.location.lng}
              latitude={spot.location.lat}
              anchor="bottom"
              onClick={(event) => {
                // Without this the map treats the click as a background click
                // and immediately closes the popup we are about to open.
                event.originalEvent.stopPropagation();
                setHovered(spot);
              }}
            >
              <button
                type="button"
                aria-label={spot.name}
                onMouseEnter={() => setHovered(spot)}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border-2 text-base shadow-md transition-transform hover:scale-110",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-white bg-card",
                )}
              >
                {isSelected ? (
                  <span className="text-xs font-bold">{stepNumber}</span>
                ) : (
                  CATEGORY_GLYPH[spot.category]
                )}
              </button>
            </Marker>
          );
        })}

        {hovered && (
          <Popup
            longitude={hovered.location.lng}
            latitude={hovered.location.lat}
            anchor="top"
            offset={12}
            closeButton
            closeOnClick={false}
            onClose={() => setHovered(null)}
            maxWidth="260px"
          >
            <div className="w-56 space-y-2 p-1">
              {hovered.photos[0] && (
                // eslint-disable-next-line @next/next/no-img-element -- Popup
                // content is outside the React tree next/image can measure.
                <img
                  src={hovered.photos[0].url}
                  alt={hovered.photos[0].caption ?? hovered.name}
                  className="h-24 w-full rounded-md object-cover"
                  loading="lazy"
                />
              )}
              <div>
                <p className="text-sm font-semibold leading-tight">{hovered.name}</p>
                <p className="text-xs text-muted-foreground">
                  {hovered.neighborhood} · {hovered.priceTier}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {hovered.vibes?.avgNoiseLevel != null && (
                  <span className="inline-flex items-center gap-1">
                    <Volume2 className="h-3 w-3" />
                    {hovered.vibes.avgNoiseLevel.toFixed(1)}/5
                  </span>
                )}
                {hovered.walkingMinutesToT != null && (
                  <span className="inline-flex items-center gap-1">
                    <Footprints className="h-3 w-3" />
                    {hovered.walkingMinutesToT} min to T
                  </span>
                )}
              </div>
              {onAddToRoute && (
                <button
                  type="button"
                  onClick={() => onAddToRoute(hovered)}
                  className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  <Plus className="h-3 w-3" /> Add to Route
                </button>
              )}
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}

export default InteractiveDateMap;
