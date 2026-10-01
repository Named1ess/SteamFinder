import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Gamepad2,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import type {
  CrawlRun,
  FetchStatus,
  GameProfileSnapshot,
  GameScoreRow,
} from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { activeRun, initials, statusText } from "../lib/graph";
import {
  formatGameHours,
  gameScoreValue,
  hasGameSetComparison,
  rankGameScores,
} from "../lib/game-scores";
import { Badge, Button, Input, cn } from "./ui";

const pageSize = 30;
const percent = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(1)}%`;
const snapshotStatus: Record<FetchStatus, string> = {
  unknown: "尚未采集",
  ok: "公开样本已采集",
  private: "样本不可访问",
  error: "采集失败",
};
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚无快照";

function PlayerAvatar({ row }: { row: GameScoreRow }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [row.player.avatar]);
  return (
    <span className="avatar">
      {row.player.avatar && !failed ? (
        <img src={row.player.avatar} alt="" onError={() => setFailed(true)} />
      ) : (
        initials(row.player.name)
      )}
    </span>
  );
}
function SnapshotMeta({
  label,
  snapshot,
  count,
}: {
  label: string;
  snapshot: GameProfileSnapshot | null;
  count?: number;
}) {
  return (
    <div className="game-snapshot-meta">
      <span>{label}</span>
      <strong>
        {snapshot?.status === "ok"
          ? `${count ?? snapshot.games.length} 款展示游戏`
          : snapshot?.games.length
            ? `保留 ${snapshot.games.length} 款旧样本`
            : "样本不可用"}
      </strong>
      <small>
        {snapshotStatus[snapshot?.status ?? "unknown"]} ·{" "}
        {date(snapshot?.fetchedAt)}
      </small>
      {snapshot?.attemptedAt && snapshot.attemptedAt !== snapshot.fetchedAt && (
        <small>最近尝试：{date(snapshot.attemptedAt)}</small>
      )}
    </div>
  );
}
function unavailableReason(
  row: GameScoreRow,
  root: GameProfileSnapshot | null,
) {
  if (!root || root.status !== "ok")
    return root?.message || "起点玩家的公开游戏样本尚不可用";
  if (row.snapshot.status !== "ok")
    return row.snapshot.message || snapshotStatus[row.snapshot.status];
  return row.result.reason || "累计时长缺失或样本累计时长为零，无法评分";
}

export function GameScoresPanel({ run }: { run?: CrawlRun }) {
  const client = useQueryClient();
  const [budget, setBudget] = useState(2000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showFormula, setShowFormula] = useState(false);
  const queryKey = ["game-scores", run?.id];
  const query = useQuery({
    queryKey,
    queryFn: () => api.gameScores(run!.id),
    enabled: !!run,
    refetchInterval: (current) =>
      activeRun(current.state.data?.job?.status) ? 2500 : false,
  });
  const collect = useMutation({
    mutationFn: (refresh: boolean) =>
      api.collectGameScores(run!.id, refresh, budget),
    onSuccess: (response) => {
      client.setQueryData(queryKey, response);
      setPage(0);
    },
  });
  const data = query.data;
  const rootStatus = data?.root?.status ?? "unknown";
  const rows = useMemo(
    () => rankGameScores(data?.rows ?? [], rootStatus),
    [data?.rows, rootStatus],
  );
  const selected = rows.find((row) => row.player.id === selectedId) ?? rows[0];
  const selectedScore = selected ? gameScoreValue(selected, rootStatus) : null;
  const selectedGameSetAvailable = selected
    ? hasGameSetComparison(selected, rootStatus)
    : false;
  const selectedTimeAvailable =
    selectedGameSetAvailable && selected?.result.timeSimilarity !== null;
  const scored = rows.filter(
    (row) => gameScoreValue(row, rootStatus) !== null,
  ).length;
  const failed =
    rows.filter((row) => row.snapshot.status === "error").length +
    (rootStatus === "error" ? 1 : 0);
  const inaccessible =
    rows.filter((row) => row.snapshot.status === "private").length +
    (rootStatus === "private" ? 1 : 0);
  const job = data?.job;
  const collecting = activeRun(job?.status);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visibleRows = rows.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    collect.mutate(false);
  };

  return (
    <section
      id="game-scores"
      className="game-panel"
      aria-labelledby="game-panel-title"
    >
      <div className="game-panel-heading">
        <div className="game-title">
          <span className="game-feature-icon">
            <Gamepad2 size={21} />
          </span>
          <div>
            <span className="panel-kicker">PUBLIC GAME SAMPLES</span>
            <h2 id="game-panel-title">
              游戏相关度 <Badge>起点与直接好友</Badge>
              {run?.mode === "demo" && <Badge tone="amber">演示数据</Badge>}
            </h2>
            <p>比较公开主页展示的游戏集合，以及这些游戏的累计时长分布。</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFormula((value) => !value)}
          aria-expanded={showFormula}
        >
          <Info size={13} />
          {showFormula ? "收起计算说明" : "如何计算"}
        </Button>
      </div>
      <div className="game-scope-banner">
        <ShieldCheck size={15} />
        <p>
          <strong>公开主页的近期展示游戏 · 部分样本</strong>
          <span>
            通常只有约 3
            款。这里使用“展示游戏的累计时长”，不是最近两周时长，也不是完整游戏库；分数不表示好友关系亲疏。
          </span>
        </p>
      </div>
      {showFormula && (
        <div className="game-formula">
          <div>
            <strong>40%</strong>
            <span>游戏集合重合度</span>
            <p>共同展示游戏数 ÷ 双方展示游戏并集数</p>
          </div>
          <span className="game-formula-plus">+</span>
          <div>
            <strong>60%</strong>
            <span>累计时长分布相似度</span>
            <p>比较每款展示游戏在各自样本总累计时长中的占比</p>
          </div>
          <div className="game-formula-note">
            两个分项均为 0–100%，加权得到 0–100
            分。缺少累计时长、样本总时长为零或网页不可访问时不评分。
          </div>
        </div>
      )}
      <form className="game-collection-toolbar" onSubmit={submit}>
        <div>
          <Database size={14} />
          <span>
            {run ? (
              <>
                <strong>{run.rootName || run.rootId}</strong>
                <small>与本次已采集的直接好友比较</small>
              </>
            ) : (
              <>
                <strong>先查询一个 Steam 好友网络</strong>
                <small>打开本面板只读取缓存，不会自动采集网页</small>
              </>
            )}
          </span>
        </div>
        <label htmlFor="game-request-budget">
          本次总请求预算
          <Input
            id="game-request-budget"
            type="number"
            min={1}
            max={10000}
            required
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
            disabled={collecting || collect.isPending}
          />
        </label>
        <Button
          size="sm"
          type="submit"
          disabled={!run || collecting || collect.isPending}
        >
          {collect.isPending || collecting ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <Gamepad2 size={13} />
          )}
          {collecting
            ? "采集中"
            : job
              ? "使用缓存 / 继续采集"
              : "采集公开游戏样本"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={
            !run ||
            collecting ||
            collect.isPending ||
            !Number.isInteger(budget) ||
            budget < 1 ||
            budget > 10000
          }
          onClick={() => collect.mutate(true)}
          title="重新请求公开主页，创建新的游戏样本采集任务"
        >
          <RefreshCw size={12} />
          刷新样本
        </Button>
      </form>
      {(query.error || collect.error) && (
        <div className="game-notice" role="alert">
          <Info size={14} />
          <span>{(collect.error || query.error)?.message}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              collect.reset();
              void query.refetch();
            }}
            disabled={!run}
          >
            重试读取
          </Button>
        </div>
      )}
      {job && (
        <div className="game-job-progress">
          <div>
            <span>
              {collecting ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <ShieldCheck size={12} />
              )}
              {statusText[job.status]}
              <small>
                {job.processedPlayers} / {job.totalPlayers} 人
              </small>
            </span>
            <span>
              {job.requestCount} / {job.maxRequests} 次请求 <i /> 缓存{" "}
              {job.cacheHits} 次 <i /> 失败 {failed} · 不可访问 {inaccessible}
            </span>
          </div>
          <div className="progress-track">
            <span
              style={{
                width: `${Math.min(100, (job.processedPlayers / Math.max(1, job.totalPlayers)) * 100)}%`,
              }}
            />
          </div>
          {job.message && <p>{job.message}</p>}
        </div>
      )}
      {run && query.isLoading ? (
        <div className="game-panel-empty">
          <LoaderCircle className="spin" size={24} />
          <strong>正在读取已保存的游戏样本</strong>
          <span>此操作不会访问 Steam</span>
        </div>
      ) : !rows.length ? (
        <div className="game-panel-empty">
          <span className="game-empty-icon">
            <Gamepad2 size={31} />
          </span>
          <strong>
            {collecting
              ? "正在发现公开展示的游戏"
              : "从共同玩过的游戏，发现更多连接"}
          </strong>
          <span>
            {run
              ? "点击采集按钮，读取起点与直接好友的公开主页样本。"
              : "先创建或打开好友网络，再主动采集游戏样本。"}
          </span>
          <small>
            采集范围仅含本次网络的起点和直接好友；私密或缺失数据不会记作 0 分。
          </small>
        </div>
      ) : (
        <div className="game-content-grid">
          <div className="game-ranking">
            <div className="game-subheading">
              <h3>样本相关度排行</h3>
              <span>
                {scored} 可评分 / {rows.length} 位直接好友
              </span>
            </div>
            <div className="game-ranking-labels">
              <span>玩家</span>
              <span>共同游戏</span>
              <span>相关度</span>
            </div>
            <div className="game-ranking-list">
              {visibleRows.map((row, index) => {
                const score = gameScoreValue(row, rootStatus);
                return (
                  <button
                    key={row.player.id}
                    className={cn(
                      "game-ranking-row",
                      selected?.player.id === row.player.id && "selected",
                    )}
                    onClick={() => setSelectedId(row.player.id)}
                  >
                    <span className="game-ranking-player">
                      <small className="game-rank-number">
                        {String(currentPage * pageSize + index + 1).padStart(
                          2,
                          "0",
                        )}
                      </small>
                      <PlayerAvatar row={row} />
                      <span>
                        <strong>{row.player.name}</strong>
                        <small>
                          {row.snapshot.status === "ok"
                            ? `${row.result.friendGameCount} 款展示游戏`
                            : snapshotStatus[row.snapshot.status]}
                        </small>
                      </span>
                    </span>
                    <span className="game-shared-count">
                      {hasGameSetComparison(row, rootStatus)
                        ? row.result.sharedGameCount
                        : "—"}
                    </span>
                    <span
                      className={cn(
                        "game-row-score",
                        score === null && "unavailable",
                      )}
                    >
                      {score === null ? (
                        "无法评分"
                      ) : (
                        <>
                          {score.toFixed(1)}
                          <small> / 100</small>
                        </>
                      )}
                    </span>
                    <ChevronRight size={12} />
                  </button>
                );
              })}
            </div>
            {pages > 1 && (
              <div className="game-pagination">
                <span>
                  {currentPage * pageSize + 1}–
                  {Math.min((currentPage + 1) * pageSize, rows.length)} /{" "}
                  {rows.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                  aria-label="相关度排行上一页"
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={currentPage >= pages - 1}
                  onClick={() => setPage(currentPage + 1)}
                  aria-label="相关度排行下一页"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </div>
          {selected && (
            <div className="game-score-detail">
              <div className="game-detail-title">
                <div>
                  <span className="panel-kicker">SAMPLE COMPARISON</span>
                  <h3>{selected.player.name}</h3>
                  <small>{selected.player.id}</small>
                </div>
                <div
                  className={cn(
                    "game-detail-score",
                    selectedScore === null && "unavailable",
                  )}
                >
                  {selectedScore === null ? (
                    <span>无法评分</span>
                  ) : (
                    <>
                      {selectedScore.toFixed(1)}
                      <small>/ 100</small>
                    </>
                  )}
                </div>
              </div>
              {selectedScore === null && (
                <div className="game-unavailable-reason">
                  <Info size={13} />
                  <span>{unavailableReason(selected, data?.root ?? null)}</span>
                </div>
              )}
              <div className="game-component-scores">
                <div>
                  <span>
                    游戏重合度 <small>权重 40%</small>
                  </span>
                  <strong>
                    {selectedGameSetAvailable
                      ? percent(selected.result.gameOverlap)
                      : "—"}
                  </strong>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${selectedGameSetAvailable ? (selected.result.gameOverlap ?? 0) : 0}%`,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <span>
                    累计时长分布 <small>权重 60%</small>
                  </span>
                  <strong>
                    {selectedTimeAvailable
                      ? percent(selected.result.timeSimilarity)
                      : "—"}
                  </strong>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${selectedTimeAvailable ? (selected.result.timeSimilarity ?? 0) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="game-snapshot-grid">
                <SnapshotMeta
                  label={`A · ${run?.rootName || "起点玩家"}`}
                  snapshot={data?.root ?? null}
                  count={selected.result.rootGameCount}
                />
                <SnapshotMeta
                  label={`B · ${selected.player.name}`}
                  snapshot={selected.snapshot}
                  count={selected.result.friendGameCount}
                />
              </div>
              <div className="game-sample-totals">
                <Clock3 size={12} />
                <span>展示游戏累计时长合计</span>
                <strong>
                  A {formatGameHours(selected.result.rootMinutes)}
                </strong>
                <strong>
                  B {formatGameHours(selected.result.friendMinutes)}
                </strong>
              </div>
              <div className="game-subheading">
                <h3>共同展示的游戏</h3>
                <Badge>
                  {selectedGameSetAvailable
                    ? `${selected.result.sharedGameCount} 款 / 并集 ${selected.result.unionGameCount} 款`
                    : "当前样本不完整"}
                </Badge>
              </div>
              <div className="game-common-table">
                <div className="game-common-table-heading">
                  <span>游戏</span>
                  <span>起点累计时长</span>
                  <span>好友累计时长</span>
                </div>
                {selectedGameSetAvailable &&
                selected.result.sharedGames.length ? (
                  selected.result.sharedGames.map((game) => (
                    <div className="game-common-row" key={game.appId}>
                      <span>
                        <strong>{game.name}</strong>
                        <small>App ID {game.appId}</small>
                      </span>
                      <span>{formatGameHours(game.rootMinutes)}</span>
                      <span>{formatGameHours(game.friendMinutes)}</span>
                    </div>
                  ))
                ) : (
                  <div className="game-common-empty">
                    {selectedGameSetAvailable
                      ? "当前公开展示样本中没有共同游戏"
                      : "样本不足，无法确认共同游戏"}
                  </div>
                )}
              </div>
              <p className="game-detail-note">
                <Sparkles size={12} />
                仅比较双方公开展示的部分游戏；刷新失败时保留成功快照及其采集时间。
              </p>
            </div>
          )}
        </div>
      )}
      <div className="game-panel-footer">
        <Users size={12} />
        <span>统计范围：起点与已采集的直接好友，不包含二度或三度玩家。</span>
        <span>打开历史记录只读取保存结果</span>
      </div>
    </section>
  );
}
