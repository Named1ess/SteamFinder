import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { RelationshipScoresPanel } from "../components/RelationshipScoresPanel";
import { ProfileHoverProvider } from "../components/ProfileHoverCard";
import type { CrawlRun, RelationshipScoreSummary } from "../../../../packages/shared/src/index";
import { createRelationshipRunSync, relationshipRingNodes } from "./relationship-scores";

const run = { id: "run-pages", rootId: "76561200100070000", status: "completed", mode: "demo" } as CrawlRun;
const player = { id: "76561200100070001", name: "Selected page player", depth: 1, avatar: null, profileUrl: "https://steamcommunity.com/" };
const row: RelationshipScoreSummary = { player, score: 23.5, networkScore: 15, mutualCount: 0, distance: 1, isDirect: true, layer: "connected" };
const metadata = {
  runId: run.id, center: { ...player, id: run.rootId, name: "Center" }, algorithmVersion: "mutual-network-groups-v2",
  computedAt: new Date().toISOString(), sourceUpdatedAt: new Date().toISOString(), totalPlayers: 135, totalEdges: 100,
  coverage: { completeLists: 136, totalLists: 136 }, layers: [{ id: "connected", label: "连接层", count: 100, minScore: 15, maxScore: 34.9 }],
};

it("renders server totals and a real loading state instead of invented detail evidence", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["relationship-scores", run.id, run.rootId, "page", 0, "", "all"], { ...metadata, rows: [row], total: 135, limit: 30, page: 0, pages: 5 });
  client.setQueryData(["relationship-scores", run.id, run.rootId, "overview"], { ...metadata, rows: [row] });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProfileHoverProvider, { mode: "demo", children: createElement(RelationshipScoresPanel, { run }) })));
  expect(html).toContain("Selected page player");
  expect(html).toContain("135");
  expect(html).toContain("展示 1 位，完整 135");
  expect(html).toContain("正在读取评分解释");
  expect(html).not.toContain("当前样本中未发现共同好友");
  client.clear();
});

it("shows a retryable refresh error even when a previous detail snapshot is cached", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["relationship-scores", run.id, run.rootId, "page", 0, "", "all"], { ...metadata, rows: [row], total: 135, limit: 30, page: 0, pages: 5 });
  client.setQueryData(["relationship-scores", run.id, run.rootId, "overview"], { ...metadata, rows: [row] });
  const detailKey = ["relationship-scores", run.id, run.rootId, "detail", player.id];
  client.setQueryData(detailKey, { ...metadata, row: { ...row, weightedMutual: 0, overlap: 0, threeHopPaths: 0, weightedIndirect: 0, components: { direct: 15, mutual: 0, overlap: 0, indirect: 0 }, commonFriends: [], evidence: "complete" } });
  await expect(client.fetchQuery({ queryKey: detailKey, queryFn: async () => { throw new Error("Detail refresh unavailable"); } })).rejects.toThrow("Detail refresh unavailable");
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProfileHoverProvider, { mode: "demo", children: createElement(RelationshipScoresPanel, { run }) })));
  expect(html).toContain("Detail refresh unavailable");
  expect(html).toContain("重试评分解释");
  expect(html).toContain("显示上次成功读取的详情");
  expect(html).toContain("网络原分");
  client.clear();
});

it("leaves the initial score request alone but replaces it when the run completes", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let resolveOld!: (value: number) => void;
  const old = new Promise<number>(resolve => { resolveOld = resolve; });
  let requests = 0, aborted = false;
  const observer = new QueryObserver(client, {
    queryKey: ["relationship-scores", run.id, run.rootId, "page"],
    queryFn: ({ signal }) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return ++requests === 1 ? old : Promise.resolve(60);
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const sync = createRelationshipRunSync(client, run.id);
    await sync({ ...run, status: "running" });
    expect(requests).toBe(1);
    expect(aborted).toBe(false);
    const finish = sync({ ...run, status: "completed" });
    resolveOld(10);
    await finish;
    expect(observer.getCurrentResult().data).toBe(60);
    expect(requests).toBe(2);
  } finally { unsubscribe(); client.clear(); }
});

it("lays out summary-only ring nodes without requiring detail fields", () => {
  const nodes = relationshipRingNodes([row]);
  expect(nodes).toHaveLength(1);
  expect(nodes[0].row.player.id).toBe(player.id);
  expect(Number.isFinite(nodes[0].x)).toBe(true);
});
