import { describe, expect, it } from "vitest";
import type { ExplorationNode } from "./graph-exploration";
import { planGraphUpdate, createGraphTaskQueue } from "./graph-updates";

const node = (id: string, overrides: Partial<ExplorationNode> = {}): ExplorationNode => ({
  id,
  name: id,
  avatar: null,
  profileUrl: "",
  depth: id === "root" ? 0 : 1,
  fetchStatus: "unknown",
  fetchedAt: null,
  friendCount: null,
  degree: 0,
  community: 0,
  ...overrides,
});
const base = {
  nodes: [node("root"), node("friend")],
  edges: [{ id: "root-friend", source: "root", target: "friend" }],
};
const positions = new Map([
  ["root", { x: 350, y: -42 }],
  ["friend", { x: 680, y: 115 }],
]);

describe("incremental graph updates", () => {
  it("distinguishes community nodes without displaying a Steam avatar", () => {
    const community = node("community:2", {
      kind: "community", community: 2, memberIds: ["a", "b", "c"],
      memberCount: 3, internalEdges: 2, avatar: "https://example.test/wrong.jpg",
    });
    const patch = planGraphUpdate(
      { nodes: [], edges: [] }, { nodes: [community], edges: [] },
      "root", "radial", new Map(),
    );
    const style = patch.add.nodes[0].style!;
    expect(style.iconSrc).toBe("");
    expect(style.iconText).toBe("3");
    expect(style.labelText).toContain("3 人");
    expect(style.labelText).toContain("2 条内部关系");
    expect(Number(style.size)).toBeGreaterThan(62);
    expect(style.lineDash).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it("does not redraw equivalent community membership arrays", () => {
    const community = node("community:2", {
      kind: "community", community: 2, memberIds: ["a", "b"], memberCount: 2,
    });
    const patch = planGraphUpdate(
      { nodes: [community], edges: [] },
      { nodes: [{ ...community, memberIds: ["a", "b"] }], edges: [] },
      "root", "radial", positions,
    );
    expect(patch.changed).toBe(false);
  });

  it("updates aggregate edge counts without replacing their endpoints", () => {
    const previous = { ...base, edges: [{ ...base.edges[0], count: 2 }] };
    const next = { ...base, edges: [{ ...base.edges[0], count: 7 }] };
    const patch = planGraphUpdate(previous, next, "root", "radial", positions);
    expect(patch.changed).toBe(true);
    expect(patch.add.edges).toEqual([]);
    expect(patch.remove.edges).toEqual([]);
    expect(patch.update.edges).toHaveLength(1);
    expect(patch.update.edges[0].style).toMatchObject({ labelText: "7", pointerEvents: "none" });
    expect(Number(patch.update.edges[0].style?.lineWidth)).toBeGreaterThan(1);
  });

  it("clears aggregate edge labels when an edge becomes an individual friendship", () => {
    const patch = planGraphUpdate(
      { ...base, edges: [{ ...base.edges[0], count: 3 }] }, base,
      "root", "radial", positions,
    );
    expect(patch.update.edges[0].style).toMatchObject({ labelText: "", lineWidth: 1 });
  });

  it("updates changed metadata without overwriting dragged coordinates", () => {
    const next = {
      ...base,
      nodes: [base.nodes[0], node("friend", { name: "New name", degree: 4 })],
    };
    const patch = planGraphUpdate(base, next, "root", "radial", positions);
    expect(patch.update.nodes).toHaveLength(1);
    expect(patch.update.nodes[0]).toMatchObject({
      id: "friend",
      data: { name: "New name", degree: 4 },
      style: { labelText: "New name", size: 40 },
    });
    expect(patch.update.nodes[0].style).not.toHaveProperty("x");
    expect(patch.update.nodes[0].style).not.toHaveProperty("y");
    expect(patch.add.nodes).toEqual([]);
    expect(patch.remove).toEqual({ nodes: [], edges: [] });
  });

  it("does not redraw an identical poll or reordered snapshot", () => {
    const patch = planGraphUpdate(
      base,
      {
        nodes: base.nodes.map((item) => ({ ...item })).reverse(),
        edges: base.edges.map((item) => ({ ...item })),
      },
      "root",
      "radial",
      positions,
    );
    expect(patch.changed).toBe(false);
    expect(patch.update.nodes).toEqual([]);
  });

  it.each(["radial", "force", "circular", "grid", "concentric"])(
    "adds analysis nodes in %s without moving existing nodes",
    (layout) => {
      const next = {
        nodes: [...base.nodes, node("analysis")],
        edges: [
          ...base.edges,
          { id: "friend-analysis", source: "friend", target: "analysis" },
        ],
      };
      const patch = planGraphUpdate(base, next, "root", layout, positions);
      expect(patch.changed).toBe(true);
      expect(patch.add.nodes.map((item) => item.id)).toEqual(["analysis"]);
      expect(patch.add.edges).toEqual([
        { id: "friend-analysis", source: "friend", target: "analysis" },
      ]);
      expect(patch.update.nodes).toEqual([]);
      const { x, y } = patch.add.nodes[0].style!;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      for (const point of positions.values()) {
        expect(
          Math.hypot(Number(x) - point.x, Number(y) - point.y),
        ).toBeGreaterThanOrEqual(71.999);
      }
    },
  );

  it("removes analysis nodes and incident edges without replacing retained nodes", () => {
    const patch = planGraphUpdate(
      base,
      { nodes: [base.nodes[0]], edges: [] },
      "root",
      "radial",
      positions,
    );
    expect(patch.remove).toEqual({ nodes: ["friend"], edges: ["root-friend"] });
    expect(patch.update.nodes).toEqual([]);
    expect(patch.add.nodes).toEqual([]);
  });

  it("restores a previously removed analysis node at its remembered position", () => {
    const patch = planGraphUpdate(
      { nodes: [base.nodes[0]], edges: [] },
      base,
      "root",
      "force",
      positions,
    );
    expect(patch.add.nodes[0].style).toMatchObject({ x: 680, y: 115 });
  });

  it("clears an old avatar when metadata switches to initials", () => {
    const previous = {
      nodes: [node("root", { avatar: "https://example.test/avatar.jpg" })],
      edges: [],
    };
    const patch = planGraphUpdate(
      previous,
      { nodes: [node("root")], edges: [] },
      "root",
      "radial",
      positions,
    );
    expect(patch.update.nodes[0].style).toMatchObject({
      iconSrc: "",
      iconText: "RO",
    });
  });

  it("updates label visibility when the snapshot crosses the crowding threshold", () => {
    const previous = {
      nodes: Array.from({ length: 30 }, (_, i) => node(i ? `n${i}` : "root")),
      edges: [],
    };
    const next = { nodes: [...previous.nodes, node("new")], edges: [] };
    const patch = planGraphUpdate(previous, next, "root", "radial", new Map());
    expect(patch.update.nodes).toHaveLength(29);
    expect(
      patch.update.nodes.every((item) => item.style?.labelOpacity === 0),
    ).toBe(true);
  });

  it("replaces a rewired edge before its former endpoint is removed", () => {
    const next = {
      nodes: [base.nodes[0], node("replacement")],
      edges: [{ id: "root-friend", source: "root", target: "replacement" }],
    };
    const patch = planGraphUpdate(base, next, "root", "radial", positions);
    expect(patch.remove).toEqual({ nodes: ["friend"], edges: ["root-friend"] });
    expect(patch.add.edges).toEqual(next.edges);
  });
});

describe("graph operation lifecycle", () => {
  it("captures after all earlier graph updates complete", async () => {
    let release!: () => void;
    let position = 1;
    const queue = createGraphTaskQueue(() => undefined);
    void queue.enqueue("data", async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      position = 2;
    });
    const captured = queue.request(() => position);
    await Promise.resolve();
    release();
    await expect(captured).resolves.toBe(2);
  });

  it("settles queued capture requests immediately when disposed during rendering", async () => {
    let release!: () => void;
    const queue = createGraphTaskQueue(() => undefined);
    void queue.enqueue("render", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const capture = queue.request(() => "should not capture");
    const disposed = queue.dispose(() => undefined);
    await expect(capture).resolves.toBeNull();
    await expect(queue.request(() => "too late")).resolves.toBeNull();
    release();
    await disposed;
  });

  it("settles failed capture requests and permits later captures", async () => {
    const errors: unknown[] = [];
    const queue = createGraphTaskQueue((error) => errors.push(error));
    await expect(queue.request(() => { throw new Error("capture failed"); })).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    await expect(queue.request(() => 42)).resolves.toBe(42);
  });

  it("cancels an active asynchronous capture before waiting for graph destruction", async () => {
    let release!: (value: string) => void;
    let destroyed = false;
    const queue = createGraphTaskQueue(() => undefined);
    const capture = queue.request(() => new Promise<string>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const disposal = queue.dispose(() => { destroyed = true; });
    await expect(capture).resolves.toBeNull();
    expect(destroyed).toBe(false);
    release("stale snapshot");
    await disposal;
    expect(destroyed).toBe(true);
  });

  it("waits for an in-flight render and coalesces pending data updates", async () => {
    const events: string[] = [];
    let release!: () => void;
    const render = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createGraphTaskQueue((error) => {
      throw error;
    });
    void queue.enqueue("render", async () => {
      events.push("render");
      await render;
    });
    await Promise.resolve();
    void queue.enqueue("data", () => {
      events.push("stale data");
    });
    const idle = queue.enqueue("data", () => {
      events.push("latest data");
    });
    expect(events).toEqual(["render"]);
    release();
    await idle;
    expect(events).toEqual(["render", "latest data"]);
  });

  it("waits to destroy a graph until rendering completes and skips queued work", async () => {
    const events: string[] = [];
    let release!: () => void;
    const render = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createGraphTaskQueue((error) => {
      throw error;
    });
    void queue.enqueue("render", async () => {
      events.push("render");
      await render;
      events.push("render finished");
    });
    await Promise.resolve();
    void queue.enqueue("data", () => {
      events.push("data");
    });
    const disposed = queue.dispose(() => {
      events.push("destroy");
    });
    void queue.enqueue("late", () => {
      events.push("late");
    });
    expect(events).toEqual(["render"]);
    release();
    await disposed;
    expect(events).toEqual(["render", "render finished", "destroy"]);
  });

  it("reports an operation failure and allows the following operation to complete", async () => {
    const errors: unknown[] = [];
    const events: string[] = [];
    const queue = createGraphTaskQueue((error) => errors.push(error));
    const error = new Error("draw failed");
    void queue.enqueue("failure", async () => {
      throw error;
    });
    await queue.enqueue("next", () => {
      events.push("next");
    });
    expect(errors).toEqual([error]);
    expect(events).toEqual(["next"]);
  });
});
