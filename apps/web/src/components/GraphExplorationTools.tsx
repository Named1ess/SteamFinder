import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Focus, FolderOpen, Save, Users, X } from "lucide-react";
import type { CrawlRun, GraphFocus, GraphNode, GraphViewState, PlayerAnnotation, SavedGraphView } from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { Button, Input } from "./ui";
import { PlayerCombobox } from "./PlayerCombobox";

interface Community { id: number; memberIds: string[]; count: number; collapsed: boolean }
export function GraphExplorationTools({ run, selected, focus, communities, protectedIds, disabled, onFocus, onCollapse, onCapture, onLoad }: {
  run: CrawlRun;
  selected?: GraphNode;
  focus: GraphFocus | null;
  communities: Community[];
  protectedIds: string[];
  disabled: boolean;
  onFocus: (focus: GraphFocus | null) => void;
  onCollapse: (ids: number[]) => void;
  onCapture: () => Promise<GraphViewState>;
  onLoad: (view: SavedGraphView) => void;
}) {
  const client = useQueryClient();
  const [playerId, setPlayerId] = useState(selected?.id ?? run.rootId);
  const [name, setName] = useState("");
  const [viewId, setViewId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => { if (selected?.id) setPlayerId(selected.id); }, [selected?.id]);
  const query = useQuery({ queryKey: ["graph-views", run.id], queryFn: ({ signal }) => api.views(run.id, signal) });
  const protectedSet = new Set(protectedIds);
  const canCollapse = (community: Community) => community.count > 1 && !community.memberIds.some(id => protectedSet.has(id));
  const collapsed = communities.filter(group => group.collapsed).map(group => group.id);
  const eligible = communities.filter(canCollapse).map(group => group.id);
  const perform = async (action: () => Promise<string>) => {
    if (pending) return;
    setPending(true); setMessage(""); setError(false);
    try { setMessage(await action()); }
    catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "视图操作失败，请重试"); }
    finally { setPending(false); }
  };
  const save = (overwrite: boolean) => perform(async () => {
    const state = await onCapture();
    const view = await api.saveView(run.id, name.trim(), state, overwrite ? viewId : undefined);
    setViewId(view.id); setName(view.name);
    await client.invalidateQueries({ queryKey: ["graph-views", run.id] });
    return `已保存「${view.name}」，布局和玩家备注已存入数据库。`;
  });
  return <div className="graph-exploration-tools" aria-label="图谱探索工具">
    <div className="exploration-focus-row">
      <div className="exploration-player"><PlayerCombobox label="聚焦玩家" runId={run.id} value={playerId} onChange={setPlayerId} selectedPlayer={selected} /></div>
      <Button size="sm" variant={focus?.hops === 1 && focus.playerId === playerId ? "default" : "secondary"} disabled={!playerId || disabled} onClick={() => onFocus({ playerId, hops: 1 })}><Focus size={13} />一跳关系</Button>
      <Button size="sm" variant={focus?.hops === 2 && focus.playerId === playerId ? "default" : "secondary"} disabled={!playerId || disabled} onClick={() => onFocus({ playerId, hops: 2 })}>两跳关系</Button>
      {focus && <Button size="sm" variant="ghost" onClick={() => onFocus(null)}><X size={13} />退出聚焦</Button>}
    </div>
    <details className="exploration-options">
      <summary><Users size={13} />社群折叠 · {collapsed.length} / {communities.length}<span>保存视图</span></summary>
      <div className="exploration-community-actions">
        <Button size="sm" variant="secondary" disabled={disabled || !eligible.length} onClick={() => onCollapse(eligible)}>折叠可折叠社群</Button>
        <Button size="sm" variant="ghost" disabled={!collapsed.length} onClick={() => onCollapse([])}>展开全部社群</Button>
      </div>
      <p className="exploration-hint">折叠当前显示范围内的社群，点击聚合节点可展开。起点、聚焦玩家、选中和高亮玩家所在社群保持展开。</p>
      <div className="exploration-communities">
        {communities.map(group => <button key={group.id} type="button" aria-pressed={group.collapsed} disabled={disabled || !canCollapse(group)} title={!canCollapse(group) ? "包含需要展示的玩家，或只有一位玩家" : `点击${group.collapsed ? "展开" : "折叠"}社群`} onClick={() => onCollapse(group.collapsed ? collapsed.filter(id => id !== group.id) : [...collapsed, group.id])}>
          社群 {group.id + 1} <strong>{group.count} 人</strong><span>{group.collapsed ? "已折叠" : "展开"}</span>
        </button>)}
      </div>
      <div className="exploration-saved">
        <label>视图名称<Input aria-label="视图名称" placeholder="例如：主要朋友圈" maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
        <div className="exploration-save-actions">
          <Button size="sm" variant="secondary" disabled={disabled || pending || !name.trim() || (query.data?.views.length ?? 0) >= 20} onClick={() => void save(false)}><Save size={13} />保存新视图</Button>
          <Button size="sm" variant="ghost" disabled={disabled || pending || !name.trim() || !viewId} onClick={() => void save(true)}>覆盖所选视图</Button>
        </div>
        <label>已保存视图<select aria-label="已保存视图" value={viewId} disabled={pending} onChange={event => { setViewId(event.target.value); const view = query.data?.views.find(item => item.id === event.target.value); if (view) setName(view.name); }}>
          <option value="">选择本次查询的视图</option>
          {query.data?.views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select></label>
        <div className="exploration-save-actions">
          <Button size="sm" variant="secondary" disabled={pending || !viewId} onClick={() => void perform(async () => { const view = await api.view(run.id, viewId); onLoad(view); setName(view.name); return view.state.sourceUpdatedAt === run.updatedAt ? `已载入「${view.name}」。` : `已载入「${view.name}」。采集数据已变化，按当前数据恢复可用节点。`; })}><FolderOpen size={13} />载入视图</Button>
          <Button size="sm" variant="ghost" disabled={pending || !viewId} onClick={() => void perform(async () => { await api.deleteView(run.id, viewId); setViewId(""); await client.invalidateQueries({ queryKey: ["graph-views", run.id] }); return "已删除所选视图，采集数据未改动。"; })}>删除视图</Button>
        </div>
        <p className="exploration-hint">每次查询最多保存 20 个视图，包含布局、位置、缩放、聚焦范围、折叠状态及玩家备注。保存前请先清除连接分析结果；载入会替换当前未保存的视图设置和备注。</p>
      </div>
      {query.isError && <div className="exploration-feedback" role="alert">{query.error.message}<Button size="sm" variant="ghost" onClick={() => void query.refetch()}>重试读取视图</Button></div>}
      {(pending || message) && <p className="exploration-feedback" role={error ? "alert" : "status"}>{pending ? "正在处理视图…" : message}</p>}
    </details>
  </div>;
}

export function GraphPlayerNotes({ player, annotation, onChange }: { player: GraphNode; annotation?: PlayerAnnotation; onChange: (value: PlayerAnnotation) => void }) {
  const [tags, setTags] = useState(annotation?.tags.join("，") ?? "");
  useEffect(() => setTags(annotation?.tags.join("，") ?? ""), [player.id, annotation?.tags.join("，")]);
  return <div className="graph-player-notes">
    <label>个人备注<textarea aria-label="玩家个人备注" value={annotation?.note ?? ""} maxLength={500} placeholder="记录你对这位玩家的备注" onChange={event => onChange({ note: event.target.value, tags: annotation?.tags ?? [] })} /></label>
    <label>标签<Input aria-label="玩家标签" value={tags} maxLength={124} placeholder="例如：常玩、一起组队" onChange={event => setTags(event.target.value)} onBlur={() => { const parsed = [...new Set(tags.split(/[,，]/).map(tag => tag.trim().slice(0, 24)).filter(Boolean))].slice(0, 5); setTags(parsed.join("，")); onChange({ note: annotation?.note ?? "", tags: parsed }); }} /></label>
    <small>最多 5 个标签，每个 24 字。备注和标签需通过上方“保存视图”保存。</small>
  </div>;
}
