import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Clock3,
  ExternalLink,
  LoaderCircle,
  MapPin,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";
import type {
  DataMode,
  FetchStatus,
  GraphNode,
} from "../../../../packages/shared/src/index";
import { api } from "../lib/api";
import {
  loadPlayerDetails,
  profileCardPosition,
  type ProfileAnchor,
} from "../lib/player-details";
import { Button } from "./ui";

type Player = Pick<GraphNode, "id" | "name">;
interface HoverTarget {
  player: Player;
  anchor: ProfileAnchor;
}
interface HoverController {
  show: (
    player: Player,
    anchor: ProfileAnchor,
    immediate?: boolean,
    trigger?: HTMLElement,
  ) => void;
  leave: () => void;
  keepOpen: () => void;
  close: (restoreFocus?: boolean) => void;
}
const HoverContext = createContext<HoverController | null>(null);
export function useProfileHover() {
  const context = useContext(HoverContext);
  if (!context) throw new Error("Profile hover provider is missing");
  return context;
}

export function ProfileHoverProvider({
  mode,
  children,
}: {
  mode: DataMode;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const triggerRef = useRef<HTMLElement | undefined>(undefined);
  const restoringFocus = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const close = useCallback((restoreFocus = false) => {
    if (
      restoreFocus &&
      document.activeElement?.closest(".profile-hover-card") &&
      triggerRef.current?.isConnected
    ) {
      restoringFocus.current = true;
      triggerRef.current.focus({ preventScroll: true });
      restoringFocus.current = false;
    }
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setTarget(null);
  }, []);
  const keepOpen = useCallback(() => {
    clearTimeout(closeTimer.current);
  }, []);
  const show = useCallback(
    (
      player: Player,
      anchor: ProfileAnchor,
      immediate = false,
      trigger?: HTMLElement,
    ) => {
      if (restoringFocus.current) return;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      const next = { player, anchor };
      const open = () => {
        triggerRef.current = trigger;
        setTarget(next);
      };
      if (immediate) open();
      else openTimer.current = setTimeout(open, 350);
    },
    [],
  );
  const leave = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setTarget(null), 250);
  }, []);
  const controller = useMemo(
    () => ({ show, leave, keepOpen, close }),
    [show, leave, keepOpen, close],
  );
  useEffect(() => close(), [mode, close]);
  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(
          ".profile-hover-card, .profile-hover-trigger, .graph-renderer",
        )
      )
        close();
    };
    const onScroll = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".profile-hover-card")
      )
        close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    const onResize = () => close();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [target, close]);
  return (
    <HoverContext.Provider value={controller}>
      {children}
      {target &&
        createPortal(
          <ProfileCard
            key={`${mode}:${target.player.id}`}
            target={target}
            mode={mode}
          />,
          document.body,
        )}
    </HoverContext.Provider>
  );
}

/** A span allows use inside existing selectable rows without nesting buttons. */
export function ProfileHoverTrigger({
  player,
  children,
  className = "",
}: {
  player: Player;
  children: ReactNode;
  className?: string;
}) {
  const hover = useProfileHover();
  return (
    <span
      className={`profile-hover-trigger ${className}`}
      tabIndex={0}
      role="button"
      aria-label={`查看 ${player.name} 的公开资料与曾用名`}
      aria-haspopup="dialog"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch")
          hover.show(
            player,
            event.currentTarget.getBoundingClientRect(),
            false,
            event.currentTarget,
          );
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") hover.leave();
      }}
      onFocus={(event) =>
        hover.show(
          player,
          event.currentTarget.getBoundingClientRect(),
          true,
          event.currentTarget,
        )
      }
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Element) ||
          !event.relatedTarget.closest(".profile-hover-card")
        )
          hover.leave();
      }}
      onClick={(event) => {
        event.stopPropagation();
        hover.show(
          player,
          event.currentTarget.getBoundingClientRect(),
          true,
          event.currentTarget,
        );
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          hover.show(
            player,
            event.currentTarget.getBoundingClientRect(),
            true,
            event.currentTarget,
          );
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                ".profile-hover-card .profile-close",
              )
              ?.focus(),
          );
        }
      }}
    >
      {children}
    </span>
  );
}

const date = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚无成功快照";
const statusText: Record<FetchStatus, string> = {
  unknown: "尚未采集",
  ok: "已保存",
  private: "未公开或无法访问",
  error: "采集失败",
};
function CacheStatus({
  status,
  fetchedAt,
  attemptedAt,
  message,
}: {
  status: FetchStatus;
  fetchedAt: string | null;
  attemptedAt: string | null;
  message: string | null;
}) {
  return (
    <div className="profile-cache-status">
      <span>
        {statusText[status]} · {date(fetchedAt)}
      </span>
      {attemptedAt && attemptedAt !== fetchedAt && (
        <span>最近尝试：{date(attemptedAt)}</span>
      )}
      {status !== "ok" && message && (
        <span className="profile-status-message">{message}</span>
      )}
    </div>
  );
}
function ProfileCard({
  target,
  mode,
}: {
  target: HoverTarget;
  mode: DataMode;
}) {
  const hover = useProfileHover();
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const client = useQueryClient();
  const queryKey = ["player-details", mode, target.player.id];
  const query = useQuery({
    queryKey,
    queryFn: () => loadPlayerDetails(target.player.id),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refresh = useMutation({
    mutationKey: ["refresh-player-details", mode, target.player.id],
    mutationFn: () => api.collectPlayerDetails(target.player.id, true),
    onSuccess: (data) => client.setQueryData(queryKey, data),
    retry: false,
  });
  const refreshing =
    useIsMutating({
      mutationKey: ["refresh-player-details", mode, target.player.id],
    }) > 0;
  const data = query.data;
  useLayoutEffect(() => {
    if (!card.current) return;
    const reposition = () => {
      if (!card.current) return;
      const rect = card.current.getBoundingClientRect();
      setPosition(
        profileCardPosition(
          target.anchor,
          rect.width,
          rect.height,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [target.anchor]);
  return (
    <div
      ref={card}
      className="profile-hover-card"
      style={position}
      role="dialog"
      aria-label={`${target.player.name} 的公开资料`}
      onPointerEnter={hover.keepOpen}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") hover.leave();
      }}
      onFocus={hover.keepOpen}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hover.leave();
      }}
    >
      <div className="profile-card-heading">
        <div>
          <span>STEAM 公开资料</span>
          <strong>
            <a
              className="profile-name-link"
              href={`https://steamcommunity.com/profiles/${encodeURIComponent(target.player.id)}/`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${target.player.name} 的 Steam 主页（新标签页打开）`}
              title="在新标签页打开 Steam 主页"
            >
              {target.player.name}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </strong>
          <small>{target.player.id}</small>
        </div>
        <Button
          className="profile-close"
          variant="ghost"
          size="icon"
          onClick={() => hover.close(true)}
          aria-label="关闭公开资料"
        >
          <X size={16} />
        </Button>
      </div>
      {query.isPending ? (
        <div className="profile-card-loading">
          <LoaderCircle size={17} className="spin" />
          <span>
            正在读取资料与曾用名…<small>首次悬停会采集缺失的公开数据</small>
          </span>
        </div>
      ) : null}
      {(query.error || refresh.error) && (
        <p role="alert" className="profile-status-message">
          {(refresh.error || query.error)?.message}
        </p>
      )}
      {data && (
        <>
          <section className="profile-header-fields">
            {data.profileStatus !== "ok" && data.profileFetchedAt && (
              <p className="profile-stale-note">
                下方为上次成功快照，当前资料未能重新确认。
              </p>
            )}
            <div>
              <UserRound size={14} />
              <span>
                <small>公开填写名称</small>
                <strong>
                  {data.profile?.realName ||
                    (data.profileStatus === "ok" ? "未填写" : "暂无可用资料")}
                </strong>
              </span>
            </div>
            <div>
              <MapPin size={14} />
              <span>
                <small>公开填写位置</small>
                <strong>
                  {data.profile?.location?.label ||
                    (data.profileStatus === "ok" ? "未填写" : "暂无可用位置")}
                </strong>
              </span>
            </div>
            <CacheStatus
              status={data.profileStatus}
              fetchedAt={data.profileFetchedAt}
              attemptedAt={data.profileAttemptedAt}
              message={data.profileMessage}
            />
          </section>
          <section className="profile-aliases">
            <h4>
              <Clock3 size={13} />
              此用户也使用过以下名称：
            </h4>
            {data.aliasesStatus !== "ok" && data.aliasesFetchedAt && (
              <p className="profile-stale-note">
                上次成功快照，当前曾用名未能重新确认。
              </p>
            )}
            {data.aliases.length ? (
              <ul>
                {data.aliases.map((alias, index) => (
                  <li key={`${index}:${alias.name}`}>
                    <strong>{alias.name}</strong>
                    {alias.changedAt && <small>{alias.changedAt}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {data.aliasesStatus === "ok"
                  ? "没有公开显示的名称记录"
                  : "暂无可用名称记录"}
              </p>
            )}
            <CacheStatus
              status={data.aliasesStatus}
              fetchedAt={data.aliasesFetchedAt}
              attemptedAt={data.aliasesAttemptedAt}
              message={data.aliasesMessage}
            />
          </section>
        </>
      )}
      <div className="profile-card-footer">
        <span>位置由用户自行填写；仅作低权重参考。</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetching || refreshing}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw size={12} className={refreshing ? "spin" : ""} />
          刷新资料
        </Button>
      </div>
    </div>
  );
}
