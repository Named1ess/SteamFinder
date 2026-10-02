import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Filter, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { CrawlRun, GraphFilters, GraphFilterResponse, GraphNode } from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { Badge, Button, Input } from "./ui";
import "../graph-discovery.css";

interface GraphFilterPanelProps {
  run: CrawlRun;
  filters: GraphFilters;
  tags: string[];
  data?: GraphFilterResponse;
  busy: boolean;
  error: Error | null;
  onApply: (filters: GraphFilters) => void;
  onPage: (page: number) => void;
  onSelect: (node: GraphNode) => void;
  onRetry: () => void;
}

const defaults = (): GraphFilters => ({ minScore: null, community: null, gameAppId: "", groupId: "", fetchStatus: "all", tag: "", unknown: "exclude" });
const filterKey = (filters: GraphFilters) => JSON.stringify([filters.minScore, filters.community, filters.gameAppId, filters.groupId, filters.fetchStatus, filters.tag, filters.unknown]);
const count = (value: number) => value.toLocaleString("zh-CN");
const fetchLabels = { ok: "好友列表已采集", private: "好友列表不可访问", error: "好友列表读取失败", unknown: "好友列表未采集" };

function SampleChoice({ id, label, placeholder, value, search, options, onSearch, onChange }: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  search: string;
  options: { id: string; name: string; count: number }[];
  onSearch: (value: string) => void;
  onChange: (value: string) => void;
}) {
  const needle = search.trim().toLocaleLowerCase();
  const selected = options.find((option) => option.id === value);
  const matching = options.filter((option) => option.id === value || !needle || option.name.toLocaleLowerCase().includes(needle) || option.id.includes(needle));
  return <div className="discovery-field discovery-sample-choice">
    <label htmlFor={`${id}-search`}>{label}</label>
    <Input id={`${id}-search`} aria-label={`搜索${label}选项`} placeholder={placeholder} value={search} onChange={(event) => onSearch(event.target.value)} maxLength={100} />
    <select id={`${id}-select`} aria-label={`选择${label}`} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">不限{label}</option>
      {value && !selected && <option value={value}>已选 ID：{value} · 当前无可用样本</option>}
      {matching.map((option) => <option key={option.id} value={option.id}>{option.name} · {count(option.count)} 人</option>)}
    </select>
    {needle && <small>{count(matching.filter((option) => option.name.toLocaleLowerCase().includes(needle) || option.id.includes(needle)).length)} 个搜索结果{value ? " · 保留已选项" : ""}</small>}
  </div>;
}

export function GraphFilterPanel({ run, filters, tags, data, busy, error, onApply, onPage, onSelect, onRetry }: GraphFilterPanelProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GraphFilters>(filters);
  const [gameSearch, setGameSearch] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const appliedKey = filterKey(filters);
  useEffect(() => { setDraft(filters); setGameSearch(""); setGroupSearch(""); }, [appliedKey, run.id]);
  const optionsQuery = useQuery({
    queryKey: ["filter-options", run.id],
    queryFn: ({ signal }) => api.filterOptions(run.id, signal),
    enabled: open,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const options = optionsQuery.data;
  const dirty = filterKey(draft) !== appliedKey;
  const activeCount = [filters.minScore !== null, filters.community !== null, !!filters.gameAppId, !!filters.groupId, filters.fetchStatus !== "all", !!filters.tag].filter(Boolean).length;
  const tagOptions = [...new Set([...tags, ...(draft.tag ? [draft.tag] : [])])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const update = <K extends keyof GraphFilters>(key: K, value: GraphFilters[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const clear = () => { const next = defaults(); setDraft(next); setGameSearch(""); setGroupSearch(""); onApply(next); };

  return <details className="graph-filter-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <Filter size={14} aria-hidden="true" /><strong>组合筛选</strong>
      <span>{activeCount ? `${activeCount} 项已应用` : "从全部已采集玩家中查找"}</span>
      {data && <Badge>{count(data.total)} 位</Badge>}
    </summary>
    {open && <div className="graph-filter-body">
      <p className="discovery-hint">条件同时满足才算匹配；聚焦时在聚焦范围内筛选。列表覆盖全部结果，画布仍受显示上限限制。</p>
      <form onSubmit={(event) => { event.preventDefault(); onApply({ ...draft }); }}>
        <div className="discovery-filter-fields">
          <label className="discovery-field" htmlFor={`${id}-score`}>
            最低关系分数
            <Input id={`${id}-score`} type="number" min={0} max={100} step="any" placeholder="不限 · 0–100" value={draft.minScore ?? ""} onChange={(event) => update("minScore", event.target.value === "" || !Number.isFinite(event.target.valueAsNumber) ? null : event.target.valueAsNumber)} />
            <small>以查询起点「{run.rootName}」为关系中心</small>
          </label>
          <label className="discovery-field" htmlFor={`${id}-community`}>
            网络社群
            <select id={`${id}-community`} value={draft.community ?? ""} onChange={(event) => update("community", event.target.value === "" ? null : Number(event.target.value))}>
              <option value="">不限社群</option>
              {draft.community !== null && !options?.communities.some((community) => community.id === draft.community) && <option value={draft.community}>社群 {draft.community + 1} · 当前选项未收录</option>}
              {options?.communities.map((community) => <option key={community.id} value={community.id}>社群 {community.id + 1} · {count(community.size)} 人</option>)}
            </select>
          </label>
          <SampleChoice id={`${id}-game`} label="公开展示游戏" placeholder="按游戏名称或 App ID 搜索" value={draft.gameAppId} search={gameSearch} options={options?.games ?? []} onSearch={setGameSearch} onChange={(value) => update("gameAppId", value)} />
          <SampleChoice id={`${id}-group`} label="公开 Steam 群组" placeholder="按群组名称或 ID 搜索" value={draft.groupId} search={groupSearch} options={options?.groups ?? []} onSearch={setGroupSearch} onChange={(value) => update("groupId", value)} />
          <label className="discovery-field" htmlFor={`${id}-status`}>
            好友列表状态
            <select id={`${id}-status`} value={draft.fetchStatus} onChange={(event) => update("fetchStatus", event.target.value as GraphFilters["fetchStatus"])}>
              <option value="all">全部状态</option>
              <option value="ok">已采集</option><option value="private">不可访问</option><option value="error">读取失败</option><option value="unknown">尚未采集</option>
            </select>
          </label>
          <label className="discovery-field" htmlFor={`${id}-tag`}>
            我的标签
            <select id={`${id}-tag`} value={draft.tag} onChange={(event) => update("tag", event.target.value)}>
              <option value="">不限标签</option>
              {tagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
            <small>来自当前视图的玩家备注</small>
          </label>
          <label className="discovery-field discovery-unknown-field" htmlFor={`${id}-unknown`}>
            资料不足的玩家
            <select id={`${id}-unknown`} value={draft.unknown} onChange={(event) => update("unknown", event.target.value as GraphFilters["unknown"])}>
              <option value="exclude">仅显示确定匹配</option>
              <option value="include">显示匹配和未知</option>
              <option value="only">仅显示未知</option>
            </select>
            <small>缺失资料不会当作 0 分；已有条件明确不匹配时仍会排除。</small>
          </label>
        </div>
        <div className="discovery-actions">
          <Button type="submit" size="sm"><Filter size={13} />应用筛选</Button>
          <Button type="button" size="sm" variant="ghost" onClick={clear}><X size={13} />清除筛选</Button>
          {dirty && <span className="discovery-draft-note">条件已修改，点击应用后生效</span>}
        </div>
      </form>
      <div className="discovery-facet-status">
        {optionsQuery.isFetching ? <span role="status"><LoaderCircle size={13} className="spin" />正在读取筛选选项…</span> : options && <span>公开游戏样本 {count(options.gamePlayers)} / {count(options.totalPlayers)} 人 · 群组样本 {count(options.groupPlayers)} / {count(options.totalPlayers)} 人</span>}
        <Button type="button" size="sm" variant="ghost" disabled={optionsQuery.isFetching} onClick={() => void optionsQuery.refetch()} aria-label="重新读取组合筛选选项"><RefreshCw size={12} />更新选项</Button>
      </div>
      {optionsQuery.isError && <div className="discovery-error" role="alert"><span>筛选选项读取失败：{optionsQuery.error.message}</span><Button type="button" size="sm" variant="ghost" onClick={() => void optionsQuery.refetch()}>重试筛选选项</Button></div>}
      <p className="discovery-hint discovery-sample-hint">游戏仅指公开主页展示的部分样本；未出现在样本里，不代表没有这款游戏。此处只读取已保存数据。</p>
      {error && <div className="discovery-error" role="alert"><span>{error.message}</span><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRetry}>重试筛选结果</Button></div>}
      {busy && <p className="discovery-loading" role="status"><LoaderCircle size={14} className="spin" />正在筛选全部已采集玩家…</p>}
      {data && <section className="discovery-filter-results" aria-label="组合筛选结果" aria-busy={busy}>
        <div className="discovery-result-summary">
          <strong>结果 {count(data.total)} 位</strong>
          <span>确定匹配 {count(data.matched)} · 未知 {count(data.unknown)} · 已排除 {count(data.excluded)}</span>
          <small>分析范围 {count(data.scopeTotal)} 位 · 画布显示 {count(data.graph.nodes.length)} 位 · 点击任一结果查看详情</small>
        </div>
        {data.rows.length ? <ul className="discovery-result-list">
          {data.rows.map((row) => <li key={row.player.id}>
            <button type="button" className="discovery-player-result" disabled={busy} onClick={() => onSelect(row.player)} aria-label={`查看筛选玩家 ${row.player.name}（${row.player.id}）`}>
              <span className="discovery-player-avatar">{row.player.avatar ? <img src={row.player.avatar} alt="" loading="lazy" /> : row.player.name.slice(0, 1)}</span>
              <span className="discovery-player-text"><strong>{row.player.name}</strong><small>{row.player.id} · {fetchLabels[row.player.fetchStatus]}</small>{row.status === "unknown" && <span className="discovery-unknown-reason">{row.unknownReasons.join("；") || "现有资料不足以确认"}</span>}</span>
              <span className="discovery-player-score"><strong>{row.score === null ? "未评分" : `${row.score.toFixed(1)} 分`}</strong><span className={row.status === "unknown" ? "discovery-unknown" : "discovery-match"}>{row.status === "unknown" ? "未知" : "匹配"}</span></span>
            </button>
          </li>)}
        </ul> : <p className="discovery-empty">没有符合当前条件的玩家。可以减少条件，或选择显示未知资料。</p>}
        <div className="discovery-pagination" aria-label="组合筛选结果分页">
          <Button type="button" size="sm" variant="secondary" disabled={busy || data.page <= 0} onClick={() => onPage(data.page - 1)} aria-label="组合筛选结果上一页"><ChevronLeft size={14} />上一页</Button>
          <span>{data.page + 1} / {Math.max(1, data.pages)} 页 · 每页 {data.pageSize} 位</span>
          <Button type="button" size="sm" variant="secondary" disabled={busy || data.page + 1 >= data.pages} onClick={() => onPage(data.page + 1)} aria-label="组合筛选结果下一页">下一页<ChevronRight size={14} /></Button>
        </div>
      </section>}
      {!data && !busy && !error && <p className="discovery-empty">选择条件并应用，即可查看匹配列表与关系图。</p>}
    </div>}
  </details>;
}
