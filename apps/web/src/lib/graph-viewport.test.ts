import { describe, expect, it } from "vitest";
import type { GraphViewportSnapshot } from "../../../../packages/shared/src/index";
import { captureGraphViewport, restoreGraphViewport } from "./graph-viewport";

describe("saved graph viewport", () => {
  it("captures current positions with hidden cached nodes and the world camera center", () => {
    const positions = new Map([
      ["hidden", { x: -80, y: 40 }],
      ["visible", { x: 0, y: 0 }],
    ]);
    const snapshot = captureGraphViewport({
      getNodeData: () => [{ id: "visible" }, { id: "invalid" }],
      getElementPosition: (id: string) => id === "visible" ? [125, -40] : [NaN, 1],
      getViewportCenter: () => [60, -90],
      getZoom: () => 1.75,
    }, positions);
    expect(snapshot).toEqual({
      positions: { hidden: { x: -80, y: 40 }, visible: { x: 125, y: -40 } },
      viewport: { center: { x: 60, y: -90 }, zoom: 1.75 },
    });
    positions.get("hidden")!.x = 999;
    expect(snapshot.positions.hidden.x).toBe(-80);
  });

  it("draws saved node positions before restoring zoom and centering in a resized viewport", async () => {
    const positions = new Map<string, { x: number; y: number }>();
    const events: unknown[] = [];
    let zoom = 1;
    let translation = [25, 50];
    const snapshot: GraphViewportSnapshot = {
      positions: { visible: { x: 120, y: -40 }, hidden: { x: 400, y: 80 } },
      viewport: { center: { x: 60, y: -90 }, zoom: 2 },
    };
    const restored = await restoreGraphViewport({
      getNodeData: () => [{ id: "visible" }],
      updateNodeData: (data) => { events.push(data); },
      draw: async () => { events.push("draw"); },
      zoomTo: async (value) => { zoom = value; events.push("zoom"); },
      getSize: () => [1000, 600],
      getViewportByCanvas: ([x, y]) => [x * zoom + translation[0], y * zoom + translation[1]],
      translateBy: async ([x, y]) => {
        translation = [translation[0] + x, translation[1] + y];
        events.push("translate");
      },
    }, snapshot, positions, () => false);
    expect(events).toEqual([
      [{ id: "visible", style: { x: 120, y: -40 } }], "draw", "zoom", "translate",
    ]);
    expect(restored).toBe(true);
    expect(positions.get("hidden")).toEqual({ x: 400, y: 80 });
    expect(translation).toEqual([380, 480]);
    expect([60 * zoom + translation[0], -90 * zoom + translation[1]]).toEqual([500, 300]);
  });

  it("does not mutate a disposed graph after its draw completes", async () => {
    let disposed = false;
    let zoomed = false;
    await restoreGraphViewport({
      getNodeData: () => [{ id: "visible" }],
      updateNodeData: () => undefined,
      draw: async () => { disposed = true; },
      zoomTo: async () => { zoomed = true; },
      getSize: () => [1000, 600],
      getViewportByCanvas: (point) => point,
      translateBy: async () => undefined,
    }, {
      positions: { visible: { x: 120, y: -40 } },
      viewport: { center: { x: 60, y: -90 }, zoom: 2 },
    }, new Map(), () => disposed);
    expect(zoomed).toBe(false);
  });

  it("ignores nonfinite saved coordinates and an invalid zoom", async () => {
    const positions = new Map<string, { x: number; y: number }>();
    let zoomed = false;
    const restored = await restoreGraphViewport({
      getNodeData: () => [],
      updateNodeData: () => undefined,
      draw: async () => undefined,
      zoomTo: async () => { zoomed = true; },
      getSize: () => [1000, 600],
      getViewportByCanvas: (point) => point,
      translateBy: async () => undefined,
    }, {
      positions: { bad: { x: Infinity, y: 2 }, good: { x: 1, y: 2 } },
      viewport: { center: { x: 0, y: 0 }, zoom: 0 },
    }, positions, () => false);
    expect([...positions]).toEqual([["good", { x: 1, y: 2 }]]);
    expect(zoomed).toBe(false);
    expect(restored).toBe(false);
  });
});
