import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, Plus, Users, X } from "lucide-react";
import type { CrawlRun, GraphNode, MultiFriendResponse } from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { Badge, Button } from "./ui";
import { PlayerCombobox } from "./PlayerCombobox";
import "../graph-discovery.css";

interface MultiFriendPanelProps {
  run?: CrawlRun;
  resetKey: number;
  onShow: (result: MultiFriendResponse) => void;
  onClear: () => void;
  onSelect: (node: GraphNode) => void;
}

export function MultiFriendPanel({ run, resetKey, onShow, onClear, onSelect }: MultiFriendPanelProps) {
  const id = useId();
  const [players, setPlayers] = useState(() => [{ key: 0, value: run?.rootId ?? "" }, { key: 1, value: "" }, { key: 2, value: "" }]);
  const nextKey = useRef(3);
  const [mode, setMode] = useState<"all" | "at-least">("all");
  const [threshold, setThreshold] = useState(2);
  const [result, setResult] = useState<MultiFriendResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const lastPage = useRef(0);
  const context = useRef({ runId: run?.id, resetKey });
  context.current = { runId: run?.id, resetKey };
  const callbacks = useRef({ onShow, onClear });
  callbacks.current = { onShow, onClear };

  const abort = () => { generation.current += 1; controller.current?.abort(); controller.current = null; };
  const clearResult = (notify: boolean) => {
    abort(); setResult(null); setPending(false); setError(null); lastPage.current = 0;
    if (notify) callbacks.current.onClear();
  };
  useEffect(() => {
    // Parent resets can follow onClear; never notify the parent from this effect.
    clearResult(false);
    return () => { generation.current += 1; controller.current?.abort(); controller.current = null; };
  }, [run?.id, resetKey]);

  const values = players.map((player) => player.value);
  const selectedCount = values.filter(Boolean).length;
  const duplicate = new Set(values.filter(Boolean)).size !== selectedCount;
  const valid = !!run && players.length >= 3 && players.length <= 10 && values.every((value) => /^\d{17}$/.test(value)) && !duplicate;
  const editPlayer = (key: number, value: string) => { clearResult(true); setPlayers((current) => current.map((player) => player.key === key ? { ...player, value } : player)); };
  const addPlayer = () => { if (players.length >= 10) return; clearResult(true); setPlayers((current) => [...current, { key: nextKey.current++, value: "" }]); };
  const removePlayer = (key: number) => { if (players.length <= 3) return; clearResult(true); setPlayers((current) => current.filter((player) => player.key !== key)); setThreshold((current) => Math.min(current, players.length - 1)); };

  const calculate = async (page = 0) => {
    if (!valid || !run) { setError(duplicate ? "每个位置请选择不同的玩家。" : "请从搜索结果中选中 3–10 位不同玩家。"); return; }
    abort();
    const requestGeneration = generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    const runId = run.id;
    const requestReset = resetKey;
    const playerIds = [...values];
    const minConnections = mode === "all" ? playerIds.length : threshold;
    const isCurrent = () => !requestController.signal.aborted && generation.current === requestGeneration && context.current.runId === runId && context.current.resetKey === requestReset;
    lastPage.current = page;
    setPending(true); setError(null);
    try {
      const next = await api.multiFriends(runId, { playerIds, minConnections, page }, requestController.signal);
      if (!isCurrent()) return;
      if (next.runId !== runId || next.minConnections !== minConnections || next.playerIds.length !== playerIds.length || new Set(next.playerIds).size !== playerIds.length || !next.playerIds.every((playerId) => playerIds.includes(playerId))) {
        throw new Error("返回的分析条件与当前选择不一致，请重新计算。");
      }
      setResult(next);
      callbacks.current.onShow(next);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "多人共同好友分析失败，请重试。");
    } finally {
      if (isCurrent()) { setPending(false); controller.current = null; }
    }
  };
  const names = new Map(result?.nodes.map((node) => [node.id, node.name]) ?? []);

  return <section className="multi-friend-panel" aria-label="多人共同好友分析">
    <div className="discovery-section-heading"><Users size={15} aria-hidden="true" /><h3>多人共同好友</h3><Badge>3–10 人</Badge></div>
    <p className="discovery-hint">选择多位玩家，找出他们都认识的人，或至少与其中几位相连的人。</p>
    <form onSubmit={(event) => { event.preventDefault(); void calculate(); }}>
      <div className="multi-friend-players">
        {players.map((player, index) => <div key={player.key} className="multi-friend-player-row">
          <PlayerCombobox label={`多人分析玩家 ${index + 1}`} runId={run?.id} value={player.value} onChange={(value) => editPlayer(player.key, value)} selectedPlayer={result?.nodes.find((node) => node.id === player.value)} />
          <Button type="button" size="icon" variant="ghost" disabled={players.length <= 3} onClick={() => removePlayer(player.key)} aria-label={`移除多人分析玩家 ${index + 1}`} title={players.length <= 3 ? "至少保留 3 个玩家位置" : "移除这个玩家位置"}><X size={14} /></Button>
        </div>)}
      </div>
      <div className="discovery-actions multi-friend-add-row"><Button type="button" size="sm" variant="secondary" disabled={!run || players.length >= 10} onClick={addPlayer}><Plus size={13} />添加玩家</Button><span>已选 {selectedCount} / {players.length} 位</span></div>
      {duplicate && <p className="discovery-error" role="alert">选择中有重复玩家，请为每个位置选择不同的人。</p>}
      <div className="multi-friend-options">
        <label className="discovery-field" htmlFor={`${id}-mode`}>匹配方式<select id={`${id}-mode`} value={mode} onChange={(event) => { clearResult(true); setMode(event.target.value as typeof mode); }}><option value="all">全部所选玩家的交集</option><option value="at-least">至少连接指定人数</option></select></label>
        {mode === "at-least" && <label className="discovery-field" htmlFor={`${id}-threshold`}>最低连接人数<select id={`${id}-threshold`} value={threshold} onChange={(event) => { clearResult(true); setThreshold(Number(event.target.value)); }}>{players.map((_, index) => <option key={index + 1} value={index + 1}>至少 {index + 1} 位</option>)}</select></label>}
      </div>
      <div className="discovery-actions multi-friend-submit-row">
        <Button type="submit" size="sm" disabled={!valid || pending}>{pending ? <LoaderCircle size={13} className="spin" /> : <Users size={13} />}计算共同好友</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!result && !pending && !error} onClick={() => clearResult(true)}><X size={13} />清除结果</Button>
      </div>
    </form>
    {!run && <p className="discovery-empty">先创建或打开一次好友查询，再选择要分析的玩家。</p>}
    {error && <div className="discovery-error" role="alert"><span>{error}</span><Button type="button" size="sm" variant="ghost" disabled={!valid || pending} onClick={() => void calculate(lastPage.current)}>重试多人分析</Button></div>}
    {pending && <p className="discovery-loading" role="status"><LoaderCircle size={14} className="spin" />正在计算已采集网络…</p>}
    {result && <div className="multi-friend-results" aria-busy={pending}>
      <div className="discovery-result-summary"><strong>找到 {result.total.toLocaleString("zh-CN")} 位玩家</strong><span>至少连接所选的 {result.minConnections} / {result.playerIds.length} 位玩家</span></div>
      <div className={`multi-friend-evidence ${result.complete ? "is-complete" : "is-partial"}`}><Badge tone={result.complete ? "green" : "amber"}>{result.complete ? "相关好友列表完整" : "部分数据"}</Badge><p>{result.message}</p></div>
      {result.rows.length ? <ul className="discovery-result-list multi-friend-result-list">
        {result.rows.map((row) => <li key={row.player.id}><button type="button" className="discovery-player-result" disabled={pending} onClick={() => onSelect(row.player)} aria-label={`查看多人分析结果 ${row.player.name}（${row.player.id}）`}>
          <span className="discovery-player-avatar">{row.player.avatar ? <img src={row.player.avatar} alt="" loading="lazy" /> : row.player.name.slice(0, 1)}</span>
          <span className="discovery-player-text"><strong>{row.player.name}</strong><small>{row.player.id}</small><span className="multi-friend-matched">相连：{row.matchedIds.map((playerId) => names.get(playerId) || playerId).join("、")}</span></span>
          <span className="multi-friend-count">{row.count}<small> / {result.playerIds.length} 人</small></span>
        </button></li>)}
      </ul> : <p className="discovery-empty">已采集数据中没有符合条件的玩家。可调整人数门槛；资料不足时不代表不存在共同好友。</p>}
      <div className="discovery-pagination" aria-label="多人共同好友结果分页">
        <Button type="button" size="sm" variant="secondary" disabled={pending || result.page <= 0} onClick={() => void calculate(result.page - 1)} aria-label="多人共同好友结果上一页"><ChevronLeft size={14} />上一页</Button>
        <span>{result.page + 1} / {Math.max(1, result.pages)} 页</span>
        <Button type="button" size="sm" variant="secondary" disabled={pending || result.page + 1 >= result.pages} onClick={() => void calculate(result.page + 1)} aria-label="多人共同好友结果下一页">下一页<ChevronRight size={14} /></Button>
      </div>
      <p className="discovery-hint">每页 {result.pageSize} 位；画布显示所选玩家及当前页结果。已选玩家不计入共同好友。</p>
    </div>}
    <p className="discovery-hint">分析使用本次查询全部已采集的关系，不受图谱筛选和显示层级限制。修改选择会清除旧结果；计算不会采集 Steam 网页。</p>
  </section>;
}
