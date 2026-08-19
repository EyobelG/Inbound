import { describe, expect, it } from "vitest";
import { buildGraph, shortestTimes } from "../graph";
import type { MbtaLine, Station } from "@/types/domain";

let counter = 0;
function station(
  name: string,
  line: MbtaLine,
  orderIndex: number,
  lng: number,
  branch: string | null = null,
): Station {
  return {
    id: `s${counter++}`,
    gtfsStopId: `place-${name.toLowerCase()}`,
    stopName: name,
    line,
    branch,
    orderIndex,
    location: { lng, lat: 42.36 },
    isAccessible: true,
  };
}

describe("buildGraph", () => {
  it("links consecutive stations on the same line", () => {
    const a = station("A", "red", 0, -71.1);
    const b = station("B", "red", 1, -71.09);
    const graph = buildGraph([a, b], []);

    expect(graph.nodes.get(a.id)!.edges.map((e) => e.toStationId)).toEqual([b.id]);
    expect(graph.nodes.get(b.id)!.edges.map((e) => e.toStationId)).toEqual([a.id]);
  });

  it("does not link stations on different branches of the same line", () => {
    const trunk = station("JFK", "red", 0, -71.05);
    const ashmont = station("Savin", "red", 1, -71.05, "ashmont");
    const braintree = station("NQuincy", "red", 1, -71.03, "braintree");

    const graph = buildGraph([trunk, ashmont, braintree], []);

    // Both branch heads hang off the trunk...
    expect(graph.nodes.get(trunk.id)!.edges).toHaveLength(2);
    // ...but never off each other.
    const ashmontNeighbors = graph.nodes.get(ashmont.id)!.edges.map((e) => e.toStationId);
    expect(ashmontNeighbors).toEqual([trunk.id]);
    expect(ashmontNeighbors).not.toContain(braintree.id);
  });

  it("groups line-platforms by physical station", () => {
    const red = station("Park", "red", 5, -71.0624);
    const green = { ...station("Park", "green_c", 5, -71.0624), gtfsStopId: red.gtfsStopId };

    const graph = buildGraph([red, green], []);
    expect(graph.byGtfsId.get(red.gtfsStopId)).toHaveLength(2);
  });
});

describe("shortestTimes", () => {
  it("charges the transfer penalty when switching lines", () => {
    const redA = station("RedA", "red", 0, -71.1);
    const redPark = station("Park", "red", 1, -71.09);
    const greenPark = { ...station("Park", "green_c", 0, -71.09), gtfsStopId: redPark.gtfsStopId };
    const greenB = station("GreenB", "green_c", 1, -71.08);

    const [lo, hi] =
      redPark.id < greenPark.id ? [redPark.id, greenPark.id] : [greenPark.id, redPark.id];
    const graph = buildGraph(
      [redA, redPark, greenPark, greenB],
      [{ a: lo, b: hi, minutes: 4 }],
    );

    const dist = shortestTimes(graph, [redA.id]);
    const toGreenPark = dist.get(greenPark.id)!.minutes;
    const toRedPark = dist.get(redPark.id)!.minutes;

    expect(toGreenPark).toBeCloseTo(toRedPark + 4, 5);
  });

  it("leaves disconnected nodes unreachable", () => {
    const red = station("Red", "red", 0, -71.1);
    const blue = station("Blue", "blue", 0, -70.99);
    const graph = buildGraph([red, blue], []);

    expect(shortestTimes(graph, [red.id]).has(blue.id)).toBe(false);
  });
});
