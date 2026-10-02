import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  GitBranch,
  Layers3,
  LoaderCircle,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import type {
  CrawlRun,
  PlayerSearchOption,
  RelationshipLayer,
  RelationshipScoreRow,
  RelationshipScoresResponse,
} from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { activeRun, initials } from "../lib/graph";
import {
  filterRelationshipScores,
  layerColors,
  paginateRelationshipScores,
  rankRelationshipScores,
  refreshRelationshipScores,
  relationshipRingNodes,
} from "../lib/relationship-scores";
import { PlayerCombobox } from "./PlayerCombobox";
import { ProfileHoverTrigger } from "./ProfileHoverCard";
import { Badge, Button, Input, cn } from "./ui";

const format = (value: number) => value.toLocaleString("zh-CN");
const scoreText = (value: number | null) =>
  value === null ? "—" : value.toFixed(1);
const layerRanges: Record<RelationshipLayer, string> = {
  core: "≥ 60 分",
  close: "35–<60 分",
  connected: "15–<35 分",
  peripheral: "< 15 分",
  unknown: "单独列出",
};

function PlayerAvatar({ player }: { player: PlayerSearchOption }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [player.avatar]);
  return (
    <ProfileHoverTrigger player={player} className="avatar relationship-avatar">
      {player.avatar && !failed ? (
        <img src={player.avatar} alt="" onError={() => setFailed(true)} />
      ) : (
        initials(player.name)
      )}
    </ProfileHoverTrigger>
  );
}

function RelationshipRings({
  data,
  rows,
  layer,
  selectedId,
  onSelect,
}: {
  data: RelationshipScoresResponse;
  rows: RelationshipScoreRow[];
  layer: RelationshipLayer | "all";
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const nodes = useMemo(() => relationshipRingNodes(rows), [rows]);
  const rings = [
    { id: "peripheral", radius: 220 },
    { id: "connected", radius: 174 },
    { id: "close", radius: 126 },
    { id: "core", radius: 78 },
  ] as const;
  const selectedNode = nodes.find(({ row }) => row.player.id === selectedId);
  const unknownCount =
    data.layers.find((item) => item.id === "unknown")?.count ?? 0;
  return (
    <div className="relationship-map">
      <div className="relationship-subheading">
        <h3>
          <Layers3 size={14} /> 分数同心环
        </h3>
        <span>越靠内，分数层级越高</span>
      </div>
      <svg
        className="relationship-rings"
        viewBox="0 0 500 500"
        role="group"
        aria-label={`以 ${data.center.name} 为中心的分数分层图；点选玩家查看解释，同心环不代表好友跳数`}
      >
        <title>关系分数同心环</title>
        <desc>
          按四个分数层级排列已知路径玩家，最多显示 100
          位。暂无已知路径的玩家不进入同心环，可在下方完整排行查看。
        </desc>
        <path d="M250 18V482 M18 250H482" className="relationship-map-axis" />
        {rings.map(({ id, radius }) => (
          <g key={id} aria-hidden="true">
            <circle
              cx={250}
              cy={250}
              r={radius}
              fill={layerColors[id]}
              fillOpacity="0.045"
              stroke={layerColors[id]}
              strokeOpacity="0.3"
              strokeDasharray="3 6"
            />
            <text
              x={250}
              y={250 - radius + 18}
              textAnchor="middle"
              fill={layerColors[id]}
              className="relationship-ring-label"
            >
              {data.layers.find((item) => item.id === id)?.label}
            </text>
          </g>
        ))}
        {selectedNode && (
          <line
            x1={250}
            y1={250}
            x2={selectedNode.x}
            y2={selectedNode.y}
            stroke={layerColors[selectedNode.row.layer]}
            strokeOpacity="0.65"
            strokeDasharray="3 4"
            aria-hidden="true"
          />
        )}
        {nodes.map(({ row, x, y }) => (
          <g
            key={row.player.id}
            role="button"
            tabIndex={0}
            aria-label={`${row.player.name}，${scoreText(row.score)} 分，${data.layers.find((item) => item.id === row.layer)?.label}，查看评分解释`}
            aria-pressed={selectedId === row.player.id}
            className={cn(
              "relationship-map-node",
              selectedId === row.player.id && "selected",
              layer !== "all" && layer !== row.layer && "dimmed",
            )}
            style={{ "--layer-color": layerColors[row.layer] } as CSSProperties}
            onClick={() => onSelect(row.player.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(row.player.id);
              }
            }}
          >
            <title>
              {row.player.name} · {scoreText(row.score)} 分 · {row.distance} 跳
            </title>
            <circle cx={x} cy={y} r={12} className="relationship-node-target" />
            <circle
              cx={x}
              cy={y}
              r={selectedId === row.player.id ? 7 : 5}
              className="relationship-node-dot"
            />
          </g>
        ))}
        <g aria-hidden="true" className="relationship-map-center">
          <circle cx={250} cy={250} r={39} />
          <text x={250} y={246} textAnchor="middle">
            {data.center.name.length > 8
              ? `${data.center.name.slice(0, 7)}…`
              : data.center.name}
          </text>
          <text
            x={250}
            y={263}
            textAnchor="middle"
            className="relationship-center-label"
          >
            评分中心
          </text>
        </g>
      </svg>
      <div className="relationship-map-caption">
        <span>
          <i /> 展示 {format(nodes.length)} 位，完整 {format(rows.length)}{" "}
          位均可搜索
        </span>
        <span>
          环内位置只作排布，虚线只提示选中玩家，不表示好友边或实际距离。
          {unknownCount > 0 && `另有 ${format(unknownCount)} 位暂无已知路径。`}
        </span>
      </div>
    </div>
  );
}

function RelationshipDetail({
  row,
  layers,
}: {
  row: RelationshipScoreRow;
  layers: RelationshipScoresResponse["layers"];
}) {
  const components = [
    {
      label: "直接好友边",
      value: row.components.direct,
      max: 15,
      note: row.isDirect ? "已观测到直接连接" : "未观测到直接连接",
    },
    {
      label: "加权共同好友",
      value: row.components.mutual,
      max: 45,
      note: `RA₂ = ${row.weightedMutual.toFixed(4)}`,
    },
    {
      label: "邻居重合度",
      value: row.components.overlap,
      max: 25,
      note: `Jaccard = ${(row.overlap * 100).toFixed(1)}%`,
    },
    {
      label: "三跳间接连接",
      value: row.components.indirect,
      max: 15,
      note: `RA₃ = ${row.weightedIndirect.toFixed(4)}`,
    },
  ];
  return (
    <aside className="relationship-detail" aria-label="所选玩家的关系评分解释">
      <div className="relationship-detail-heading">
        <PlayerAvatar player={row.player} />
        <div>
          <span className="panel-kicker">WHY THIS SCORE</span>
          <h3>{row.player.name}</h3>
          <small>{row.player.id}</small>
        </div>
        <div
          className={cn(
            "relationship-detail-score",
            row.score === null && "unavailable",
          )}
        >
          <strong>{scoreText(row.score)}</strong>
          <small>{row.score === null ? "暂无评分" : "/ 100"}</small>
        </div>
      </div>
      <div className="relationship-detail-tags">
        <span style={{ color: layerColors[row.layer] }}>
          {layers.find((item) => item.id === row.layer)?.label}
        </span>
        <span>
          <GitBranch size={12} />
          {row.distance === null
            ? "暂无已知路径"
            : `最短已知路径 ${row.distance} 跳`}
        </span>
      </div>
      {row.score === null ? (
        <p className="relationship-evidence-note">
          已采集的网络中暂无通向此玩家的路径，因此不评分。私密或尚未采集的好友列表可能隐藏连接。
        </p>
      ) : row.score === 0 ? (
        <p className="relationship-evidence-note">
          已有已知路径，但三跳内的评分证据不足，当前为 0
          分；这不表示现实中互不相识。
        </p>
      ) : null}
      <div className="relationship-components">
        {components.map((item) => (
          <div key={item.label}>
            <span>
              {item.label}
              <small>{item.note}</small>
            </span>
            <strong>
              {row.score === null ? "—" : item.value.toFixed(1)}
              <small> / {item.max}</small>
            </strong>
            <div className="progress-track">
              <span
                style={{
                  width: `${row.score === null ? 0 : (item.value / item.max) * 100}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="relationship-facts">
        <span>
          <Users size={13} />
          共同好友<strong>{format(row.mutualCount)}</strong>
        </span>
        <span>
          <GitBranch size={13} />
          三跳简单路径<strong>{format(row.threeHopPaths)}</strong>
        </span>
      </div>
      <div className="relationship-common-friends">
        <span>
          共同好友示例<small>最多展示 5 位</small>
        </span>
        {row.commonFriends.length ? (
          <div>
            {row.commonFriends.map((player) => (
              <span key={player.id} className="relationship-common-friend">
                <PlayerAvatar player={player} />
                <span title={`${player.name} · ${player.id}`}>
                  {player.name}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p>当前样本中未发现共同好友。</p>
        )}
      </div>
      <div
        className={cn(
          "relationship-evidence",
          row.evidence === "complete" && "complete",
        )}
      >
        <ShieldCheck size={14} />
        <p>
          <strong>
            {row.evidence === "complete"
              ? "评分所需局部邻域样本完整"
              : "评分所需局部邻域样本不完整"}
          </strong>
          <span>
            完整要求双方及相邻玩家的好友列表采集成功、在 24
            小时内且已完整收录。覆盖情况单独展示，不作为分数乘数。
          </span>
        </p>
      </div>
    </aside>
  );
}

export function RelationshipScoresPanel({ run }: { run?: CrawlRun }) {
  const client = useQueryClient();
  const [centerId, setCenterId] = useState(run?.rootId ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<RelationshipLayer | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [showFormula, setShowFormula] = useState(false);
  const query = useQuery({
    queryKey: ["relationship-scores", run?.id, centerId],
    queryFn: ({ signal }) => api.relationshipScores(run!.id, centerId, signal),
    enabled: !!run && !!centerId,
    refetchInterval: activeRun(run?.status) ? 2500 : false,
  });
  useEffect(() => {
    if (run?.id) void refreshRelationshipScores(client, run.id);
  }, [
    client,
    run?.id,
    run?.nodeCount,
    run?.edgeCount,
    run?.fetchedCount,
    run?.status,
    run?.updatedAt,
  ]);
  // Editing clears the committed ID immediately; a previous center's cache is never rendered.
  const data =
    centerId &&
    query.data?.center.id === centerId &&
    query.data.runId === run?.id
      ? query.data
      : undefined;
  const rows = useMemo(
    () => rankRelationshipScores(data?.rows ?? []),
    [data?.rows],
  );
  const filtered = useMemo(
    () => filterRelationshipScores(rows, search, layer),
    [rows, search, layer],
  );
  const pagination = useMemo(
    () => paginateRelationshipScores(filtered, page),
    [filtered, page],
  );
  const selected =
    rows.find((row) => row.player.id === selectedId) ?? filtered[0] ?? rows[0];
  const changeCenter = (id: string) => {
    setCenterId(id);
    setSelectedId(null);
    setLayer("all");
    setSearch("");
    setPage(0);
  };
  const chooseLayer = (id: RelationshipLayer | "all") => {
    setLayer(id);
    setPage(0);
    setSelectedId(null);
  };

  return (
    <section
      id="relationship-scores"
      className="relationship-panel"
      aria-labelledby="relationship-panel-title"
    >
      <div className="relationship-panel-heading">
        <div className="relationship-title">
          <span className="relationship-feature-icon">
            <Layers3 size={22} />
          </span>
          <div>
            <span className="panel-kicker">RELATIONSHIP LAYERS</span>
            <h2 id="relationship-panel-title">
              关系分层 <Badge>全部已采集玩家</Badge>
              {run?.mode === "demo" && <Badge tone="amber">演示数据</Badge>}
            </h2>
            <p>围绕一位玩家，按好友网络中的连接证据查看关系分数。</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFormula((value) => !value)}
          aria-expanded={showFormula}
          aria-controls="relationship-formula"
        >
          <CircleHelp size={14} />
          如何计算
        </Button>
      </div>
      <div className="relationship-scope">
        <ShieldCheck size={15} />
        <p>
          这是项目自定义的网络结构分数，不代表现实亲密程度或概率。仅使用已保存的好友网络，与游戏相关度独立；进入面板和切换中心不会发起
          Steam 采集。
        </p>
      </div>
      {showFormula && (
        <div className="relationship-formula" id="relationship-formula">
          <strong>
            分数 = 15 × 直接边 + 45 × RA₂ / (RA₂ + 1) + 25 × Jaccard + 15 × RA₃
            / (RA₃ + 1)
          </strong>
          <p>
            RA₂ 累加每位共同好友的 1 / 度数；RA₃
            对每条恰好三条边、无重复玩家的路径累加 1 /
            两位中间玩家度数的乘积。中间玩家度数取已观测连接数、公开好友数与 1
            的最大值，降低高连接节点的贡献。
          </p>
          <p>
            Jaccard
            比较双方邻居集合的交集与并集，先从集合中排除对方。各项先保留一位小数后求和。公式权重与层级阈值是项目选择，未做现实亲密度校准；不完整的网络样本会改变结果。
          </p>
          <p>
            分数层级与最短好友跳数分别计算。暂无已知路径时不评分；已连接但超过三跳的玩家可能为
            0 分。
          </p>
        </div>
      )}
      <div className="relationship-toolbar">
        <PlayerCombobox
          label="评分中心"
          runId={run?.id}
          value={centerId}
          onChange={changeCenter}
          selectedPlayer={data?.center}
        />
        {run && centerId !== run.rootId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => changeCenter(run.rootId)}
          >
            回到起点
          </Button>
        )}
        <div className="relationship-coverage">
          <Database size={14} />
          <span>
            <strong>
              {data
                ? `${format(data.totalPlayers)} 位玩家 · ${format(data.totalEdges)} 条连接`
                : "读取本次全部已采集网络"}
            </strong>
            <small>
              {data
                ? `完整新鲜好友列表 ${format(data.coverage.completeLists)} / ${format(data.coverage.totalLists)} · 不受主图显示上限影响`
                : "不受主图显示上限和显示深度影响"}
            </small>
          </span>
          {query.isFetching && data && (
            <LoaderCircle
              size={14}
              className="spin"
              aria-label="正在更新关系分数"
            />
          )}
        </div>
      </div>
      {query.isError && centerId && (
        <div className="relationship-notice" role="alert">
          <CircleHelp size={15} />
          <span>{query.error.message}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            重试读取
          </Button>
        </div>
      )}
      {!run || !centerId || (!data && query.isPending) ? (
        <div className="relationship-empty" role="status">
          {run && centerId ? (
            <LoaderCircle size={26} className="spin" />
          ) : (
            <Layers3 size={30} />
          )}
          <strong>
            {!run
              ? "先打开或创建好友网络"
              : !centerId
                ? "请选择评分中心"
                : "正在计算已保存网络的关系分数"}
          </strong>
          <span>
            {!centerId && run
              ? "从搜索结果中选中玩家，即可围绕该玩家重新分层。"
              : "全部分析均在已有采集数据上完成。"}
          </span>
        </div>
      ) : data && !rows.length ? (
        <div className="relationship-empty">
          <Users size={28} />
          <strong>当前网络中还没有其他玩家</strong>
          <span>随着网络采集更新，这里会自动显示可比较的玩家。</span>
        </div>
      ) : data ? (
        <>
          <div
            className="relationship-layer-cards"
            aria-label="按关系分数层级筛选"
          >
            {data.layers.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "relationship-layer-card",
                  layer === item.id && "selected",
                )}
                style={
                  { "--layer-color": layerColors[item.id] } as CSSProperties
                }
                aria-pressed={layer === item.id}
                onClick={() => chooseLayer(layer === item.id ? "all" : item.id)}
              >
                <span>
                  <i />
                  {item.label}
                </span>
                <strong>
                  {format(item.count)}
                  <small>人</small>
                </strong>
                <small>{layerRanges[item.id]}</small>
              </button>
            ))}
          </div>
          <div className="relationship-visual-grid">
            <RelationshipRings
              data={data}
              rows={rows}
              layer={layer}
              selectedId={selected?.player.id}
              onSelect={setSelectedId}
            />
            {selected && (
              <RelationshipDetail row={selected} layers={data.layers} />
            )}
          </div>
          <div className="relationship-ranking">
            <div className="relationship-ranking-heading">
              <div>
                <h3>全部玩家排行</h3>
                <span>按关系分数从高到低 · 共 {format(rows.length)} 位</span>
              </div>
              <label className="relationship-search">
                <Search size={14} />
                <Input
                  aria-label="搜索关系排行中的玩家"
                  placeholder="搜索昵称或 Steam ID"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
              </label>
            </div>
            <div className="relationship-ranking-filter">
              <Button
                variant="ghost"
                size="sm"
                className={layer === "all" ? "selected" : undefined}
                aria-pressed={layer === "all"}
                onClick={() => chooseLayer("all")}
              >
                全部层级
              </Button>
              <span>
                {layer === "all"
                  ? "包含暂无已知路径的玩家"
                  : data.layers.find((item) => item.id === layer)?.label}{" "}
                · {format(filtered.length)} 位符合条件
              </span>
            </div>
            <div className="relationship-ranking-labels" aria-hidden="true">
              <span>玩家</span>
              <span>共同好友</span>
              <span>最短路径</span>
              <span>关系分数</span>
            </div>
            <div className="relationship-ranking-list">
              {pagination.rows.map((row, index) => (
                <div
                  key={row.player.id}
                  className={cn(
                    "relationship-ranking-row",
                    selected?.player.id === row.player.id && "selected",
                  )}
                >
                  <span className="relationship-row-avatar">
                    <PlayerAvatar player={row.player} />
                  </span>
                  <button
                    type="button"
                    className="relationship-row-select"
                    aria-pressed={selected?.player.id === row.player.id}
                    aria-label={`查看 ${row.player.name} 的评分解释，${row.score === null ? "暂无已知路径" : `${scoreText(row.score)} 分`}`}
                    onClick={() => setSelectedId(row.player.id)}
                  >
                    <span className="relationship-row-player">
                      <span>
                        <small className="relationship-rank-number">
                          {pagination.page * 30 + index + 1}
                        </small>
                        <strong>{row.player.name}</strong>
                      </span>
                      <small>
                        {row.player.id}
                        <i />
                        {
                          data.layers.find((item) => item.id === row.layer)
                            ?.label
                        }
                      </small>
                    </span>
                    <span className="relationship-row-mutual">
                      {format(row.mutualCount)}
                      <small>位</small>
                    </span>
                    <span className="relationship-row-distance">
                      {row.distance === null ? "未知" : `${row.distance} 跳`}
                    </span>
                    <strong
                      className={cn(
                        "relationship-row-score",
                        row.score === null && "unavailable",
                      )}
                    >
                      {scoreText(row.score)}
                      <small>{row.score === null ? "暂无评分" : "/ 100"}</small>
                    </strong>
                  </button>
                </div>
              ))}
              {!pagination.rows.length && (
                <div className="relationship-no-matches">
                  没有符合条件的玩家，试试其他昵称或层级。
                </div>
              )}
            </div>
            <div className="relationship-pagination">
              <span>
                {filtered.length
                  ? `${pagination.page * 30 + 1}–${Math.min((pagination.page + 1) * 30, filtered.length)}`
                  : "0"}{" "}
                / {format(filtered.length)} 位
              </span>
              <span>
                第 {pagination.page + 1} / {pagination.pages} 页
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关系排行上一页"
                disabled={pagination.page === 0}
                onClick={() => setPage(pagination.page - 1)}
              >
                <ChevronLeft size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关系排行下一页"
                disabled={pagination.page >= pagination.pages - 1}
                onClick={() => setPage(pagination.page + 1)}
              >
                <ChevronRight size={15} />
              </Button>
            </div>
          </div>
          <p className="relationship-footnote">
            样本时间：{new Date(data.sourceUpdatedAt).toLocaleString("zh-CN")} ·
            评分算法 {data.algorithmVersion} · 点击头像可查看公开资料与曾用名。
          </p>
        </>
      ) : null}
    </section>
  );
}
