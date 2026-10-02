import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, LoaderCircle, RefreshCw, ShieldCheck, Users } from "lucide-react";
import type { CrawlRun, RunGroupsResponse } from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import { activeRun, statusText } from "../lib/graph";
import { refreshQuerySnapshot, replaceQuerySnapshot } from "../lib/query-refresh";
import { Button, Input } from "./ui";

const format = (value: number) => value.toLocaleString("zh-CN");

export function GroupCollectionPanel({
  run,
  onSnapshot,
}: {
  run?: CrawlRun;
  onSnapshot: (snapshot: RunGroupsResponse) => Promise<void>;
}) {
  const client = useQueryClient();
  const budgetId = useId();
  const [budget, setBudget] = useState(500);
  const queryKey = ["run-groups", run?.id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.runGroups(run!.id, signal),
    enabled: !!run,
    refetchInterval: (current) =>
      activeRun(current.state.data?.job?.status) ? 2500 : false,
  });
  const collect = useMutation({
    mutationFn: ({ refresh, maxRequests }: { refresh: boolean; maxRequests: number }) =>
      api.collectGroups(run!.id, refresh, maxRequests),
    onSuccess: (response) => replaceQuerySnapshot(client, queryKey, response),
  });
  const data = query.data?.runId === run?.id ? query.data : undefined;
  const job = data?.job;
  const collecting = activeRun(job?.status);
  const validBudget = Number.isInteger(budget) && budget >= 1 && budget <= 10000;
  const canCollect = !!run && !!data && validBudget && !collecting && !collect.isPending;
  const retrySubmission = collect.variables;
  const canRetrySubmission = !!run && !collect.isPending && job?.status !== "running" &&
    !!retrySubmission && Number.isInteger(retrySubmission.maxRequests) &&
    retrySubmission.maxRequests >= 1 && retrySubmission.maxRequests <= 10000;

  useEffect(() => {
    if (data) void onSnapshot(data);
  }, [data, onSnapshot]);
  // A growing run can add players before its first group job is created.
  useEffect(() => {
    if (run?.id) void refreshQuerySnapshot(client, ["run-groups", run.id]);
  }, [client, run?.id, run?.nodeCount]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canCollect) collect.mutate({ refresh: false, maxRequests: budget });
  };

  return (
    <div className="relationship-group-collection" aria-label="公开群组采集">
      <div className="relationship-group-intro">
        <span className="relationship-group-icon"><Users size={17} /></span>
        <div>
          <h3>公开群组 <span>关系分数的辅助证据</span></h3>
          <p>主动采集本次已保存的全体玩家的公开群组列表。打开页面只读缓存；共同群组最多提供 10 分加成，缺失或没有交集均不扣分。</p>
        </div>
      </div>
      <form className="relationship-group-actions" onSubmit={submit}>
        <label htmlFor={budgetId}>
          本次群组请求预算
          <Input
            id={budgetId}
            type="number"
            min={1}
            max={10000}
            step={1}
            required
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
            disabled={!data || collecting || collect.isPending}
          />
        </label>
        <Button size="sm" type="submit" disabled={!canCollect}>
          {collecting || collect.isPending ? <LoaderCircle size={13} className="spin" /> : <Users size={13} />}
          {collecting ? "群组采集中" : job ? "使用缓存 / 继续采集群组" : "采集公开群组"}
        </Button>
        <Button size="sm" variant="secondary" type="button" disabled={!canCollect} onClick={() => collect.mutate({ refresh: true, maxRequests: budget })} title="重新请求公开群组页面，创建新的群组采集任务">
          <RefreshCw size={12} />刷新群组
        </Button>
        {query.isFetching && <span className="relationship-group-reading" role="status"><LoaderCircle size={12} className="spin" />读取群组状态</span>}
      </form>
      {data && (
        <div className="relationship-group-coverage" aria-label="群组样本覆盖">
          <span><i className="available" />完整可用 <strong>{format(data.coverage.availablePlayers)}</strong></span>
          <span><i className="unavailable" />不可用 <strong>{format(data.coverage.unavailablePlayers)}</strong></span>
          <span><i />待采集 <strong>{format(data.coverage.pendingPlayers)}</strong></span>
          <span className="relationship-group-total">{job ? "本轮覆盖" : "本次已存"} {format(data.coverage.totalPlayers)} 位玩家</span>
        </div>
      )}
      {job && (
        <div className="relationship-group-progress" aria-label="群组采集进度">
          <div>
            <span>{collecting ? <LoaderCircle size={12} className="spin" /> : <ShieldCheck size={12} />}{statusText[job.status]}<strong>{format(job.processedPlayers)} / {format(job.totalPlayers)} 人</strong></span>
            <span>请求 {format(job.requestCount)} / {format(job.maxRequests)} 次 · 缓存 {format(job.cacheHits)} 次</span>
          </div>
          <div className="progress-track" role="progressbar" aria-label="群组采集完成比例" aria-valuemin={0} aria-valuemax={job.totalPlayers || 1} aria-valuenow={Math.min(job.processedPlayers, job.totalPlayers)}><span style={{ width: `${Math.min(100, job.processedPlayers / Math.max(1, job.totalPlayers) * 100)}%` }} /></div>
          {job.message && <p>{job.message}</p>}
          {run && run.nodeCount > job.totalPlayers && <p>本轮固定覆盖启动时的 {format(job.totalPlayers)} 位玩家；新增玩家可在本轮结束后继续采集。</p>}
        </div>
      )}
      {(query.error || collect.error) && (
        <div className="relationship-group-notice" role="alert">
          <CircleHelp size={14} />
          <span>{(collect.error || query.error)?.message}</span>
          {collect.error && retrySubmission && (
            <Button type="button" variant="secondary" size="sm" disabled={!canRetrySubmission} onClick={() => collect.mutate(retrySubmission)}>重试提交群组任务</Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={!run || query.isFetching} onClick={() => void query.refetch()}>重试读取群组状态</Button>
        </div>
      )}
    </div>
  );
}
