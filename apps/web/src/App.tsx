import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Compass,
  ExternalLink,
  GitBranch,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Network,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type {
  AnalysisResult,
  CrawlRun,
  GraphNode,
} from "../../../packages/shared/src/index";
import { DEFAULT_ROOT } from "../../../packages/shared/src/index";
import { api } from "./lib/api";
import { refreshQuerySnapshot } from "./lib/query-refresh";
import {
  activeRun,
  fetchText,
  initials,
  matchesAnalysisSelection,
  mergeGraph,
  relativeTime,
  statusText,
} from "./lib/graph";
import { Badge, Button, Input, cn } from "./components/ui";
import { GameScoresPanel } from "./components/GameScoresPanel";
import { RelationshipScoresPanel } from "./components/RelationshipScoresPanel";
import { PlayerCombobox } from "./components/PlayerCombobox";
import {
  ProfileHoverProvider,
  ProfileHoverTrigger,
} from "./components/ProfileHoverCard";

const NetworkGraph = lazy(() => import("./components/NetworkGraph"));
const OverviewChart = lazy(() => import("./components/OverviewChart"));
const format = (value: number) => value.toLocaleString("zh-CN");
const getRunId = () => new URLSearchParams(window.location.search).get("run");

function Avatar({
  node,
  large = false,
}: {
  node: Pick<GraphNode, "id" | "name" | "avatar">;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [node.avatar]);
  return (
    <ProfileHoverTrigger
      player={node}
      className={cn("avatar", large && "avatar-large")}
    >
      {node.avatar && !failed ? (
        <img src={node.avatar} alt="" onError={() => setFailed(true)} />
      ) : (
        initials(node.name)
      )}
    </ProfileHoverTrigger>
  );
}
function EmptyNetwork({
  onStart,
  pending,
  demo,
  blocked,
}: {
  onStart: () => void;
  pending: boolean;
  demo: boolean;
  blocked: boolean;
}) {
  return (
    <div className="empty-network">
      <div className="empty-constellation" aria-hidden="true">
        <svg viewBox="0 0 340 200">
          <defs>
            <linearGradient id="network-line">
              <stop stopColor="#6ee8cf" stopOpacity=".6" />
              <stop offset="1" stopColor="#8493dd" stopOpacity=".15" />
            </linearGradient>
          </defs>
          <g stroke="url(#network-line)" fill="none">
            <path d="M170 96 88 43 38 100 102 158 170 96 261 146 302 62 170 96 218 28M88 43 218 28 302 62M102 158 261 146" />
          </g>
          <g fill="#182b3c" stroke="#426475">
            <circle cx="88" cy="43" r="16" />
            <circle cx="38" cy="100" r="10" />
            <circle cx="102" cy="158" r="14" />
            <circle cx="218" cy="28" r="12" />
            <circle cx="261" cy="146" r="17" />
            <circle cx="302" cy="62" r="11" />
          </g>
          <circle cx="170" cy="96" r="44" fill="#65d5bf" opacity=".045" />
          <circle
            cx="170"
            cy="96"
            r="31"
            fill="#173b3d"
            stroke="#65d5bf"
            strokeWidth="1.5"
          />
          <circle cx="170" cy="88" r="8" fill="#8ce6d2" />
          <path d="M156 111c0-15 28-15 28 0" fill="#8ce6d2" />
        </svg>
        <span className="constellation-dot dot-one" />
        <span className="constellation-dot dot-two" />
      </div>
      <Badge tone="green">
        <Compass size={11} /> 从一个人，发现整个网络
      </Badge>
      <h2>你的下一段连接，从这里开始</h2>
      <p>
        输入 Steam 主页或 ID，展开好友之间的联系。
        <br />
        发现共同好友，看看你们之间隔了几度。
      </p>
      <Button onClick={onStart} disabled={pending || blocked}>
        {pending ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Sparkles size={16} />
        )}
        {demo ? "探索演示网络" : "查询示例 Steam ID"}
        <ArrowRight size={16} />
      </Button>
      <span className="empty-note">
        {demo
          ? "使用本地生成的示例数据 · 不访问 Steam"
          : "点击后采集 Steam 公开网页 · 无需登录或密钥"}
      </span>
    </div>
  );
}

export function App() {
  const client = useQueryClient();
  const [runId, setRunId] = useState<string | null>(getRunId);
  const [input, setInput] = useState("");
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(1000);
  const [maxRequests, setMaxRequests] = useState(500);
  const [displayDepth, setDisplayDepth] = useState(3);
  const [displayLimit, setDisplayLimit] = useState(500);
  const [layout, setLayout] = useState("radial");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const latestAnalysisSelection = useRef({ runId, from, to });
  latestAnalysisSelection.current = { runId, from, to };
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [resumeNodes, setResumeNodes] = useState(2000);
  const [resumeRequests, setResumeRequests] = useState(1000);
  const [notice, setNotice] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [rightTab, setRightTab] = useState<"overview" | "analysis">("overview");
  const analysisPanel = useRef<HTMLElement>(null);
  const config = useQuery({
    queryKey: ["config"],
    queryFn: api.config,
    staleTime: 60000,
  });
  const history = useQuery({
    queryKey: ["runs"],
    queryFn: api.runs,
    refetchInterval: 10000,
  });
  const current = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: !!runId,
    refetchInterval: (query) =>
      activeRun(query.state.data?.status) ? 2500 : false,
  });
  const run = current.data;
  useEffect(() => {
    if (run?.id)
      void refreshQuerySnapshot(client, ["run-players", run.id]);
  }, [client, run?.id, run?.nodeCount, run?.status]);
  useEffect(() => {
    // Polling can observe completion before SSE, so always read the final graph.
    if (run?.id && !activeRun(run.status))
      void refreshQuerySnapshot(client, ["graph", run.id]);
  }, [client, run?.id, run?.status]);
  const graphQuery = useQuery({
    queryKey: ["graph", runId, displayLimit, displayDepth],
    queryFn: ({ signal }) =>
      api.graph(
        runId!,
        displayLimit,
        Math.min(displayDepth, run?.depth ?? 3),
        signal,
      ),
    enabled: !!run,
    refetchInterval: activeRun(run?.status) ? 3500 : false,
  });
  const graph = graphQuery.data;
  const merged = useMemo(() => mergeGraph(graph, analysis), [graph, analysis]);
  const selected = merged.nodes.find((node) => node.id === selectedId);
  const matches = useMemo(
    () =>
      search.trim()
        ? merged.nodes.filter((node) =>
            `${node.name} ${node.id}`
              .toLowerCase()
              .includes(search.toLowerCase().trim()),
          )
        : [],
    [search, merged.nodes],
  );
  const highlights = useMemo(
    () =>
      analysis
        ? [
            ...new Set(
              [...analysis.nodeIds, ...analysis.path, from, to].filter(Boolean),
            ),
          ]
        : matches.map((node) => node.id),
    [analysis, matches, from, to],
  );
  const demo = (run?.mode ?? config.data?.mode) === "demo";
  const busy = activeRun(run?.status);
  const selectRun = (next: CrawlRun) => {
    const url = new URL(window.location.href);
    url.searchParams.set("run", next.id);
    window.history.pushState({}, "", url);
    client.setQueryData(["run", next.id], next);
    setRunId(next.id);
    setDisplayDepth(next.depth);
    setSelectedId(next.rootId);
    setAnalysis(null);
    setSearch("");
    setFrom(next.rootId);
    setTo("");
    setNotice(null);
  };
  useEffect(() => {
    const pop = () => {
      const nextRunId = getRunId();
      if (nextRunId === runId) return;
      setRunId(nextRunId);
      setAnalysis(null);
      setSelectedId(null);
      setSearch("");
      setFrom("");
      setTo("");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [runId]);
  useEffect(() => {
    if (!run) return;
    setFrom(run.rootId);
    setTo("");
    setSelectedId(run.rootId);
    setDisplayDepth(run.depth);
    setResumeNodes(Math.min(10000, run.maxNodes + 1000));
    setResumeRequests(Math.min(10000, run.maxRequests + 500));
    // A stored run is read only; this effect never starts collection.
  }, [run?.id]);
  useEffect(() => {
    setSseConnected(false);
    if (!runId || !busy) return;
    const events = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events`,
    );
    let lastGraphUpdate = 0;
    events.onopen = () => setSseConnected(true);
    events.onerror = () => setSseConnected(false);
    events.addEventListener("progress", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as CrawlRun;
        client.setQueryData(["run", runId], next);
        if (Date.now() - lastGraphUpdate > 1200 || !activeRun(next.status)) {
          lastGraphUpdate = Date.now();
          void refreshQuerySnapshot(client, ["graph", runId]);
          void client.invalidateQueries({ queryKey: ["runs"] });
        }
      } catch {
        /* Polling remains available if the stream is interrupted. */
      }
    });
    return () => events.close();
  }, [runId, busy, client]);
  const create = useMutation({
    mutationFn: api.create,
    onSuccess: (result) => {
      selectRun(result.run);
      setNotice(
        result.cached
          ? "已打开缓存中的好友图谱。首次解析自定义主页地址可能调用 Steam。"
          : "查询已创建，采集进度将实时更新。",
      );
      void client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const updateRun = (next: CrawlRun) => {
    client.setQueryData(["run", next.id], next);
    void refreshQuerySnapshot(client, ["graph", next.id]);
    void client.invalidateQueries({ queryKey: ["runs"] });
  };
  const cancel = useMutation({
    mutationFn: () => api.cancel(runId!),
    onSuccess: updateRun,
  });
  const resume = useMutation({
    mutationFn: () => api.resume(runId!, resumeNodes, resumeRequests),
    onSuccess: updateRun,
  });
  const analyze = useMutation({
    mutationFn: async (kind: "mutual" | "path") => {
      const selection = { runId, from, to };
      const result = await api.analysis(
        selection.runId!,
        kind,
        selection.from,
        selection.to,
      );
      return { result, selection };
    },
    onSuccess: ({ result, selection }) => {
      if (!matchesAnalysisSelection(selection, latestAnalysisSelection.current))
        return;
      setAnalysis(result);
      setSearch("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    create.mutate({ input: input.trim(), depth, maxNodes, maxRequests });
  };
  const startExample = () =>
    create.mutate({
      input: config.data?.defaultRoot || DEFAULT_ROOT,
      depth: 2,
      maxNodes: 1000,
      maxRequests: 500,
    });
  const showAnalysis = () => {
    setRightTab("analysis");
    analysisPanel.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };
  const mutationError =
    create.error || cancel.error || resume.error || analyze.error;
  const error =
    mutationError || current.error || graphQuery.error || config.error;
  const changeFrom = (id: string) => {
    setFrom(id);
    setTo((currentTo) => (currentTo === id ? "" : currentTo));
    setAnalysis(null);
  };

  return (
    <ProfileHoverProvider mode={config.data?.mode ?? run?.mode ?? "live"}>
      <div className="app-shell">
        <aside className="sidebar">
          <a className="brand" href="/" aria-label="SteamFinder 首页">
            <span className="brand-mark">
              <Network size={24} strokeWidth={2} />
            </span>
            <span>
              Steam<span className="brand-light">Finder</span>
              <small>好友网络探索</small>
            </span>
          </a>
          <div className="sidebar-nav">
            <button
              className="nav-item active"
              onClick={() =>
                document
                  .querySelector(".workspace")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              <Network size={17} />
              关系图谱
              <span className="nav-dot" />
            </button>
            <button className="nav-item" onClick={showAnalysis}>
              <GitBranch size={17} />
              连接分析
              <ChevronRight size={14} />
            </button>
            <a className="nav-item" href="#relationship-scores">
              <Layers3 size={17} />
              关系分层
              <ChevronRight size={14} />
            </a>
          </div>
          <div className="sidebar-divider" />
          <form className="query-form" onSubmit={submit}>
            <div className="section-label">
              <Search size={14} /> 新建查询
            </div>
            <label className="field-label" htmlFor="steam-input">
              Steam 主页 / Steam ID
            </label>
            <div className="input-wrap">
              <Input
                id="steam-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                required
                placeholder="粘贴主页链接或 17 位 ID"
                autoComplete="off"
              />
              <Search size={15} />
            </div>
            <button
              className="example-link"
              type="button"
              onClick={() => setInput(DEFAULT_ROOT)}
            >
              试试示例 ID <ArrowUpRight size={12} />
            </button>
            <div className="field-heading">
              <label className="field-label">探索深度</label>
              <span>最多 {config.data?.maxDepth ?? 3} 度</span>
            </div>
            <div className="depth-options">
              {[1, 2, 3].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn("depth-option", depth === value && "selected")}
                  onClick={() => setDepth(value)}
                  disabled={value > (config.data?.maxDepth ?? 3)}
                >
                  {value} 度{value === 2 && <span>推荐</span>}
                </button>
              ))}
            </div>
            <div className="budget-grid">
              <label>
                节点预算
                <Input
                  type="number"
                  min={1}
                  max={config.data?.maxNodes ?? 10000}
                  required
                  value={maxNodes}
                  onChange={(event) => setMaxNodes(Number(event.target.value))}
                />
              </label>
              <label>
                请求预算
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  required
                  value={maxRequests}
                  onChange={(event) =>
                    setMaxRequests(Number(event.target.value))
                  }
                />
              </label>
            </div>
            <Button
              className="query-submit"
              type="submit"
              disabled={create.isPending || !config.data}
            >
              {create.isPending ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Search size={15} />
              )}
              {demo ? "探索好友网络" : "开始采集"}
              <ArrowRight size={15} />
            </Button>
            <p className="query-note">
              <ShieldCheck size={12} />
              仅主动查询会触发采集
            </p>
          </form>
          <div className="sidebar-divider" />
          <div className="history-heading">
            <span className="section-label">
              <Clock3 size={14} /> 查询历史
            </span>
            <span>{history.data?.runs.length ?? 0}</span>
            <button
              onClick={() => void history.refetch()}
              title="更新历史"
              aria-label="更新查询历史"
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="history-list">
            {history.isLoading ? (
              <p className="sidebar-empty">正在读取历史…</p>
            ) : history.error ? (
              <p className="sidebar-empty error-text">历史读取失败，请重试。</p>
            ) : !history.data?.runs.length ? (
              <div className="history-empty">
                <Clock3 size={23} />
                <span>还没有查询记录</span>
                <small>你的每次探索都会保存在这里</small>
              </div>
            ) : (
              history.data.runs.map((item) => (
                <button
                  key={item.id}
                  className={cn(
                    "history-item",
                    runId === item.id && "selected",
                  )}
                  onClick={() => selectRun(item)}
                >
                  <ProfileHoverTrigger
                    player={{
                      id: item.rootId,
                      name: item.rootName || item.rootId,
                    }}
                    className="history-avatar"
                  >
                    {initials(item.rootName || item.rootId)}
                  </ProfileHoverTrigger>
                  <span className="history-content">
                    <strong>{item.rootName || item.rootId}</strong>
                    <span>
                      {item.depth} 度 · {format(item.nodeCount)} 个节点 <i />
                      {relativeTime(item.createdAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "history-status",
                      item.status === "completed" && "done",
                      activeRun(item.status) && "working",
                    )}
                    title={statusText[item.status]}
                  />
                  {item.mode === "demo" && (
                    <span className="history-demo">演示</span>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="sidebar-footer">
            <span className="local-dot" />
            <span>
              本地工作区<small>数据保存在你的设备上</small>
            </span>
            <LockKeyhole size={14} />
          </div>
        </aside>

        <main className="workspace">
          <header className="workspace-header">
            <div className="breadcrumb">
              <span>工作区</span>
              <ChevronRight size={12} />
              <span>关系图谱</span>
            </div>
            <div className="header-right">
              <Badge tone={demo ? "amber" : "green"}>
                <span className="badge-dot" />
                {config.isLoading
                  ? "连接中"
                  : demo
                    ? "演示模式"
                    : "公开网页采集"}
              </Badge>
              <span className="header-local">LOCAL</span>
            </div>
          </header>
          <div className="workspace-title">
            <div>
              <div className="eyebrow">EXPLORE THE CONNECTIONS</div>
              <h1>
                每一段好友关系，都有迹可循<span className="title-dot">.</span>
              </h1>
              <p>从一个玩家出发，发现 Steam 社交网络中的连接。</p>
            </div>
            <span className="workspace-icon">
              <Network size={33} strokeWidth={1.2} />
            </span>
          </div>
          {demo && (
            <div className="demo-banner">
              <Sparkles size={14} />
              <span>
                演示工作区
                <span className="banner-detail">
                  {" "}
                  · 使用生成的好友网络，人物与关系均为示例
                </span>
              </span>
              <Badge>DEMO DATA</Badge>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check size={15} />
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} aria-label="关闭提示">
                <X size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice notice-error" role="alert">
              <CircleHelp size={16} />
              <span>{error.message}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  create.reset();
                  cancel.reset();
                  resume.reset();
                  analyze.reset();
                  void config.refetch();
                  if (runId) void current.refetch();
                  if (run) void graphQuery.refetch();
                }}
              >
                重试读取
              </Button>
            </div>
          )}
          <div className="main-grid">
            <section className="network-panel">
              <div className="metrics-row">
                {[
                  {
                    label: "已发现玩家",
                    value: run?.nodeCount,
                    icon: Users,
                    note: "采集范围内",
                  },
                  {
                    label: "好友连接",
                    value: run?.edgeCount,
                    icon: GitBranch,
                    note: "已知关系",
                  },
                  {
                    label: "网络社群",
                    value: graph?.stats.communities.length,
                    icon: Layers3,
                    note: "已采集网络",
                  },
                ].map((metric) => (
                  <div className="metric" key={metric.label}>
                    <div className="metric-label">
                      <metric.icon size={14} />
                      {metric.label}
                    </div>
                    <div className="metric-value">
                      {metric.value === undefined ? "—" : format(metric.value)}
                      <span>{metric.note}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="graph-heading">
                <div>
                  <span className="panel-kicker">FRIENDSHIP MAP</span>
                  <h2>
                    {run
                      ? `${run.rootName || "Steam 玩家"} 的好友网络`
                      : "关系图谱"}
                    {run && (
                      <Badge
                        tone={
                          busy
                            ? "green"
                            : run.status === "failed"
                              ? "red"
                              : "default"
                        }
                      >
                        {busy && <span className="badge-dot pulse" />}
                        {statusText[run.status]}
                      </Badge>
                    )}
                  </h2>
                </div>
                <div className="run-actions">
                  {run &&
                    (busy ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate()}
                      >
                        <Pause size={13} />
                        暂停
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={create.isPending}
                        onClick={() =>
                          create.mutate({
                            input: run.rootId,
                            depth: run.depth,
                            maxNodes: run.maxNodes,
                            maxRequests: run.maxRequests,
                            refresh: true,
                          })
                        }
                        title="重新向 Steam 请求数据"
                      >
                        <RefreshCw size={13} />
                        刷新采集
                      </Button>
                    ))}
                </div>
              </div>
              {run && (
                <div className="graph-toolbar">
                  <div className="graph-search">
                    <Search size={14} />
                    <Input
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setAnalysis(null);
                      }}
                      placeholder="搜索玩家名称或 ID"
                      aria-label="搜索图中玩家"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch("")}
                        aria-label="清除搜索"
                      >
                        <X size={12} />
                      </button>
                    )}
                    {search && (
                      <div className="search-results">
                        <span>
                          {matches.length
                            ? `${matches.length} 个匹配节点`
                            : "当前显示范围内没有匹配节点"}
                        </span>
                        {matches.slice(0, 8).map((node) => (
                          <button
                            key={node.id}
                            onClick={() => {
                              setSelectedId(node.id);
                              setSearch("");
                            }}
                          >
                            <Avatar node={node} />
                            <span>{node.name}</span>
                            <ArrowRight size={12} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="toolbar-selects">
                    <label>
                      <Layers3 size={13} />
                      <select
                        value={displayDepth}
                        onChange={(event) =>
                          setDisplayDepth(Number(event.target.value))
                        }
                        aria-label="显示层级"
                      >
                        {[1, 2, 3]
                          .filter((value) => value <= run.depth)
                          .map((value) => (
                            <option value={value} key={value}>
                              显示 {value} 度
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      <select
                        value={displayLimit}
                        onChange={(event) =>
                          setDisplayLimit(Number(event.target.value))
                        }
                        aria-label="图谱显示节点上限"
                      >
                        {[100, 250, 500, 1000].map((value) => (
                          <option value={value} key={value}>
                            {value} 节点
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <select
                        value={layout}
                        onChange={(event) => setLayout(event.target.value)}
                        aria-label="图谱布局"
                      >
                        <option value="radial">径向布局</option>
                        <option value="circular">环形布局</option>
                        <option value="grid">网格布局</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}
              <div className={cn("graph-canvas", !run && "empty-canvas")}>
                {!run ? (
                  current.isLoading ? (
                    <div className="canvas-loading">
                      <LoaderCircle className="spin" />
                      正在读取图谱…
                    </div>
                  ) : (
                    <EmptyNetwork
                      onStart={startExample}
                      pending={create.isPending}
                      demo={demo}
                      blocked={!config.data}
                    />
                  )
                ) : graphQuery.isLoading ? (
                  <div className="canvas-loading">
                    <LoaderCircle className="spin" />
                    正在绘制你的好友网络…
                  </div>
                ) : merged.nodes.length ? (
                  <Suspense
                    fallback={
                      <div className="canvas-loading">
                        <LoaderCircle className="spin" />
                        正在准备图谱…
                      </div>
                    }
                  >
                    <NetworkGraph
                      nodes={merged.nodes}
                      edges={merged.edges}
                      rootId={run.rootId}
                      selectedId={selectedId}
                      highlightIds={highlights}
                      layout={layout}
                      onSelect={setSelectedId}
                    />
                  </Suspense>
                ) : (
                  <div className="canvas-loading">
                    <Network size={35} />
                    <strong>
                      {busy ? "正在发现第一批好友" : "当前范围暂无节点"}
                    </strong>
                    <span>
                      {busy
                        ? "采集结果将在这里实时出现"
                        : "调整显示层级或重新采集"}
                    </span>
                  </div>
                )}
                {run && (
                  <div className="canvas-corner">
                    <span className="live-dot" />
                    {busy
                      ? sseConnected
                        ? "实时更新中"
                        : "轮询更新中"
                      : "已保存的网络快照"}
                  </div>
                )}
                {run && (
                  <div className="graph-legend">
                    <span>
                      <i className="legend-root" />
                      查询起点
                    </span>
                    <span>
                      <i className="legend-friend" />
                      好友节点
                    </span>
                    <span>
                      <i className="legend-private" />
                      不可访问
                    </span>
                    {analysis && (
                      <button onClick={() => setAnalysis(null)}>
                        <X size={11} />
                        清除分析高亮
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="graph-footer">
                <span>
                  <Activity size={12} />
                  {run
                    ? `画布显示 ${format(merged.nodes.length)} / ${format(graph?.totalNodes ?? run.nodeCount)} 个已采集节点`
                    : "准备好发现新的连接了吗？"}
                </span>
                <span>
                  {graph?.truncated
                    ? "已限制显示 · 分析仍使用全部已采集数据"
                    : "拖动平移 · 滚轮缩放 · 点击查看节点"}
                </span>
              </div>
              {run && (
                <div className="run-progress">
                  <div className="progress-heading">
                    <span>
                      {busy ? (
                        <LoaderCircle className="spin" size={13} />
                      ) : (
                        <ShieldCheck size={13} />
                      )}
                      {statusText[run.status]}
                      <small>
                        {run.message ||
                          `已采集 ${format(run.fetchedCount)} 个好友列表，复用缓存 ${format(run.cacheHits)} 次`}
                      </small>
                    </span>
                    <strong>
                      {format(run.requestCount)}
                      <span> / {format(run.maxRequests)} 请求</span>
                    </strong>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${Math.min(100, (run.requestCount / Math.max(1, run.maxRequests)) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="progress-meta">
                    <span>
                      不可访问 {run.privateCount} · 失败 {run.errorCount}
                    </span>
                    <span>
                      节点预算 {format(run.maxNodes)} · {run.depth} 度
                    </span>
                  </div>
                  {["limited", "cancelled", "failed"].includes(run.status) && (
                    <form
                      className="resume-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        resume.mutate();
                      }}
                    >
                      <span>继续采集 · 调整总预算</span>
                      <label>
                        节点
                        <Input
                          type="number"
                          min={run.nodeCount || 1}
                          max={10000}
                          required
                          value={resumeNodes}
                          onChange={(event) =>
                            setResumeNodes(Number(event.target.value))
                          }
                        />
                      </label>
                      <label>
                        请求
                        <Input
                          type="number"
                          min={run.requestCount + 1}
                          max={10000}
                          required
                          value={resumeRequests}
                          onChange={(event) =>
                            setResumeRequests(Number(event.target.value))
                          }
                        />
                      </label>
                      <Button
                        size="sm"
                        type="submit"
                        disabled={resume.isPending}
                      >
                        {resume.isPending ? (
                          <LoaderCircle className="spin" size={13} />
                        ) : (
                          <Play size={13} />
                        )}
                        继续
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </section>

            <aside className="inspector" ref={analysisPanel}>
              <div className="inspector-tabs">
                <button
                  className={cn(rightTab === "overview" && "active")}
                  onClick={() => setRightTab("overview")}
                >
                  <Compass size={14} />
                  网络概览
                </button>
                <button
                  className={cn(rightTab === "analysis" && "active")}
                  onClick={() => setRightTab("analysis")}
                >
                  <GitBranch size={14} />
                  连接分析
                </button>
              </div>
              {rightTab === "overview" ? (
                <>
                  <section className="detail-section">
                    <div className="inspector-heading">
                      <h3>节点详情</h3>
                      <span>
                        {selected
                          ? `${selected.depth} 度节点`
                          : "点击图谱中的节点"}
                      </span>
                    </div>
                    {selected ? (
                      <>
                        <div className="profile">
                          <Avatar node={selected} large />
                          <div>
                            <h3>{selected.name}</h3>
                            <span className="profile-id">{selected.id}</span>
                            <Badge
                              tone={
                                selected.fetchStatus === "ok"
                                  ? "green"
                                  : selected.fetchStatus === "error"
                                    ? "red"
                                    : "amber"
                              }
                            >
                              {selected.fetchStatus === "private" && (
                                <LockKeyhole size={10} />
                              )}
                              {fetchText[selected.fetchStatus]}
                            </Badge>
                          </div>
                        </div>
                        <div className="node-facts">
                          <div>
                            <span>已知连接</span>
                            <strong>{format(selected.degree)}</strong>
                          </div>
                          <div>
                            <span>完整好友数</span>
                            <strong>
                              {selected.friendCount === null
                                ? "未知"
                                : format(selected.friendCount)}
                            </strong>
                          </div>
                          <div>
                            <span>所属社群</span>
                            <strong>{selected.community + 1}</strong>
                          </div>
                        </div>
                        <div className="profile-actions">
                          <Button asChild variant="secondary" size="sm">
                            <a
                              href={selected.profileUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Steam 主页
                              <ExternalLink size={12} />
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              changeFrom(selected.id);
                              showAnalysis();
                            }}
                          >
                            设为分析起点
                            <ArrowRight size={12} />
                          </Button>
                        </div>
                        {selected.fetchedAt && (
                          <p className="freshness">
                            好友列表快照：
                            {new Date(selected.fetchedAt).toLocaleString(
                              "zh-CN",
                            )}
                            <br />
                            {Date.now() -
                              new Date(selected.fetchedAt).getTime() >
                            86400000
                              ? "旧快照 · 可主动刷新采集"
                              : "结果反映采集时的状态"}
                          </p>
                        )}
                        {selected.fetchStatus !== "ok" && (
                          <p className="scope-note">
                            不可访问、失败与边界节点不代表没有好友；已知关系仍会保留。
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="detail-empty">
                        <span>
                          <Users size={24} />
                        </span>
                        <strong>认识网络里的每一个人</strong>
                        <p>
                          选中一个玩家，查看好友连接、
                          <br />
                          所属社群和采集状态。
                        </p>
                      </div>
                    )}
                  </section>
                  <section className="overview-section">
                    <div className="inspector-heading">
                      <h3>网络结构</h3>
                      <Badge>采集范围内</Badge>
                    </div>
                    {graph ? (
                      <>
                        <div className="chart-grid">
                          <div>
                            <span className="chart-title">层级分布</span>
                            <Suspense
                              fallback={<div className="chart-placeholder" />}
                            >
                              <OverviewChart
                                stats={graph.stats}
                                kind="layers"
                              />
                            </Suspense>
                          </div>
                          <div>
                            <span className="chart-title">社群分布</span>
                            <Suspense
                              fallback={<div className="chart-placeholder" />}
                            >
                              <OverviewChart
                                stats={graph.stats}
                                kind="communities"
                              />
                            </Suspense>
                          </div>
                        </div>
                        <div className="collection-summary">
                          <span>
                            <i className="summary-dot complete" />
                            已采集 <strong>{graph.stats.fetchedNodes}</strong>
                          </span>
                          <span>
                            <i className="summary-dot boundary" />
                            边界 <strong>{graph.stats.frontierNodes}</strong>
                          </span>
                          <span>
                            <i className="summary-dot private" />
                            不可访问 <strong>{graph.stats.privateNodes}</strong>
                          </span>
                          <span>
                            <i className="summary-dot failed" />
                            失败 <strong>{graph.stats.failedNodes}</strong>
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="chart-empty">
                        <span className="placeholder-bar" />
                        <span className="placeholder-bar" />
                        <span className="placeholder-bar" />
                        <span className="placeholder-bar" />
                        <p>开始探索后，网络结构将在这里呈现</p>
                      </div>
                    )}
                  </section>
                  <section className="connectors-section">
                    <div className="inspector-heading">
                      <h3>连接者排行</h3>
                      <span>已知连接数</span>
                    </div>
                    {graph?.stats.topConnectors.length ? (
                      graph.stats.topConnectors
                        .slice(0, 5)
                        .map((node, index) => (
                          <button
                            className="connector-row"
                            key={node.id}
                            disabled={
                              !merged.nodes.some((item) => item.id === node.id)
                            }
                            title={
                              merged.nodes.some((item) => item.id === node.id)
                                ? "查看节点"
                                : "该节点不在当前显示范围，请增加显示上限"
                            }
                            onClick={() => setSelectedId(node.id)}
                          >
                            <span
                              className={cn("rank", index === 0 && "first")}
                            >
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="connector-name">{node.name}</span>
                            <span className="connector-bar">
                              <i
                                style={{
                                  width: `${Math.max(4, (node.count / Math.max(1, graph.stats.topConnectors[0].count)) * 100)}%`,
                                }}
                              />
                            </span>
                            <strong>{format(node.count)}</strong>
                          </button>
                        ))
                    ) : (
                      <div className="ranking-empty">
                        谁是网络中连接最多的人？
                        <br />
                        查询完成后即可查看。
                      </div>
                    )}
                    <p className="scope-note">
                      统计仅针对本次已采集网络，不代表完整 Steam 好友网络。
                    </p>
                  </section>
                </>
              ) : (
                <section className="analysis-section">
                  <div className="inspector-heading">
                    <h3>发现彼此的连接</h3>
                    <GitBranch size={15} />
                  </div>
                  <p>
                    按昵称或 Steam ID 搜索两个玩家，查找共同好友或最短连接路径。
                  </p>
                  <div className="analysis-person">
                    <span className="person-marker">A</span>
                    <PlayerCombobox
                      key={`from-${runId ?? "no-run"}`}
                      label="起点玩家"
                      runId={run?.id}
                      value={from}
                      onChange={changeFrom}
                      selectedPlayer={merged.nodes.find(
                        (node) => node.id === from,
                      )}
                    />
                  </div>
                  <span className="person-connector" />
                  <div className="analysis-person">
                    <span className="person-marker secondary">B</span>
                    <PlayerCombobox
                      key={`to-${runId ?? "no-run"}`}
                      label="终点玩家"
                      runId={run?.id}
                      value={to}
                      excludeId={from}
                      onChange={(id) => {
                        setTo(id);
                        setAnalysis(null);
                      }}
                      selectedPlayer={merged.nodes.find(
                        (node) => node.id === to,
                      )}
                    />
                  </div>
                  <div className="analysis-buttons">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={
                        !run || !from || !to || from === to || analyze.isPending
                      }
                      onClick={() => analyze.mutate("mutual")}
                    >
                      <Users size={13} />
                      共同好友
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        !run || !from || !to || from === to || analyze.isPending
                      }
                      onClick={() => analyze.mutate("path")}
                    >
                      <GitBranch size={13} />
                      最短路径
                    </Button>
                  </div>
                  {analyze.isPending && (
                    <div className="analysis-empty">
                      <LoaderCircle className="spin" size={23} />
                      正在分析已采集网络…
                    </div>
                  )}
                  {analysis && (
                    <div className="analysis-result">
                      <div className="result-heading">
                        <span>
                          {analysis.kind === "mutual"
                            ? "已知共同好友"
                            : "连接路径"}
                        </span>
                        <strong>
                          {analysis.kind === "mutual"
                            ? analysis.nodeIds.length
                            : analysis.path.length
                              ? analysis.path.length - 1
                              : "—"}
                          <small>
                            {analysis.kind === "mutual" ? " 人" : " 度"}
                          </small>
                        </strong>
                      </div>
                      <p>{analysis.message}</p>
                      <Badge tone={analysis.complete ? "green" : "amber"}>
                        {analysis.complete
                          ? "相关好友列表完整"
                          : "部分数据 · 结果可能不完整"}
                      </Badge>
                      <div className="path-list">
                        {(analysis.kind === "path"
                          ? analysis.path
                          : analysis.nodeIds
                        ).map((id, index) => {
                          const node = merged.nodes.find(
                            (item) => item.id === id,
                          );
                          return (
                            <button
                              key={id}
                              onClick={() => {
                                setSelectedId(id);
                                setRightTab("overview");
                              }}
                            >
                              <span>
                                {analysis.kind === "path" ? (
                                  index + 1
                                ) : (
                                  <Users size={12} />
                                )}
                              </span>
                              <strong>{node?.name || id}</strong>
                              <ArrowUpRight size={12} />
                            </button>
                          );
                        })}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAnalysis(null)}
                      >
                        <X size={12} />
                        清除结果
                      </Button>
                    </div>
                  )}
                  {!analysis && !analyze.isPending && (
                    <div className="analysis-empty">
                      <GitBranch size={32} />
                      <strong>朋友的朋友，可能也是朋友</strong>
                      <span>选择 A 和 B，探索彼此的关系</span>
                    </div>
                  )}
                  <div className="analysis-scope">
                    <ShieldCheck size={17} />
                    <p>
                      分析使用本次查询的全部已采集节点，与画布显示上限无关。分析所需节点会自动加入画布。私密、失败或边界节点会影响结果完整性。
                    </p>
                  </div>
                </section>
              )}
              <div className="inspector-footer">
                <CircleHelp size={13} />
                <span>以连接为线索，让探索更有方向</span>
              </div>
            </aside>
          </div>
          <RelationshipScoresPanel key={`relationships:${run?.id ?? "no-run"}`} run={run} />
          <GameScoresPanel key={run?.id ?? "no-run"} run={run} />
          <footer className="workspace-footer">
            <span>
              STEAMFINDER <i /> 让关系可见
            </span>
            <span>独立项目 · 与 Valve / Steam 无关联</span>
          </footer>
        </main>
      </div>
    </ProfileHoverProvider>
  );
}
