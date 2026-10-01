import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, LoaderCircle, Search, X } from "lucide-react";
import type { PlayerSearchOption } from "../../../../packages/shared/src/index";
import { api } from "../lib/api";

interface PlayerComboboxProps {
  label: string;
  runId?: string;
  value: string;
  onChange: (id: string) => void;
  excludeId?: string;
  selectedPlayer?: PlayerSearchOption;
  disabled?: boolean;
}

export function PlayerCombobox({
  label,
  runId,
  value,
  onChange,
  excludeId = "",
  selectedPlayer,
  disabled = false,
}: PlayerComboboxProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastSelected = useRef<PlayerSearchOption | null>(null);
  const composing = useRef(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [compositionVersion, setCompositionVersion] = useState(0);
  const queryText = editing ? search.trim() : "";
  const isDisabled = disabled || !runId;

  useEffect(() => {
    if (value) {
      setEditing(false);
      setSearch("");
      setDebouncedSearch("");
    }
  }, [value]);

  useEffect(() => {
    if (composing.current) return;
    const timer = window.setTimeout(() => setDebouncedSearch(queryText), 200);
    return () => window.clearTimeout(timer);
  }, [queryText, compositionVersion]);

  const query = useQuery({
    queryKey: ["run-players", runId, debouncedSearch, value, excludeId],
    queryFn: ({ signal }) =>
      api.searchPlayers(runId!, {
        q: debouncedSearch,
        selectedId: value,
        excludeId,
        signal,
      }),
    enabled: !isDisabled && (open || !!value),
    staleTime: 10000,
  });
  const selected =
    (query.data?.selected?.id === value ? query.data.selected : null) ??
    (selectedPlayer?.id === value ? selectedPlayer : null) ??
    (lastSelected.current?.id === value ? lastSelected.current : null);
  if (selected) lastSelected.current = selected;
  const pending = queryText !== debouncedSearch || query.isLoading;
  const players = pending || query.isError ? [] : (query.data?.players ?? []);
  const total = query.data?.total ?? 0;
  const displayValue = editing ? search : selected?.name || value;

  useEffect(() => setActiveIndex(-1), [debouncedSearch, value, excludeId]);
  useEffect(() => {
    if (activeIndex >= 0 && open)
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const selectPlayer = (player: PlayerSearchOption) => {
    lastSelected.current = player;
    setEditing(false);
    setSearch("");
    setDebouncedSearch("");
    onChange(player.id);
    inputRef.current?.focus();
    // Focus can fire on touch selection; close after its onFocus handler runs.
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!players.length) return;
      setActiveIndex((index) =>
        !open
          ? event.key === "ArrowDown"
            ? 0
            : players.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % players.length
            : (index <= 0 ? players.length : index) - 1,
      );
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const player = players[activeIndex];
      if (player) selectPlayer(player);
    }
  };

  return (
    <div
      className="player-combobox"
      ref={containerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label className="player-combobox-label" htmlFor={`${id}-input`}>
        {label}
      </label>
      <div className="player-combobox-field">
        <Search size={13} aria-hidden="true" />
        <input
          id={`${id}-input`}
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-activedescendant={
            open && players[activeIndex]
              ? `${id}-option-${activeIndex}`
              : undefined
          }
          aria-describedby={`${id}-selection`}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          value={displayValue}
          disabled={isDisabled}
          placeholder="搜索昵称或 Steam ID"
          onFocus={(event) => {
            setOpen(true);
            if (!editing) event.currentTarget.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setSearch(event.target.value);
            setEditing(true);
            setActiveIndex(-1);
            setOpen(true);
            // An unfinished search must never submit the previously selected ID.
            if (value) onChange("");
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            setCompositionVersion((version) => version + 1);
          }}
          onKeyDown={handleKeyDown}
        />
        {displayValue && !isDisabled ? (
          <button
            type="button"
            className="player-combobox-clear"
            aria-label={`清除${label}`}
            onClick={() => {
              setSearch("");
              setDebouncedSearch("");
              setEditing(true);
              setActiveIndex(-1);
              onChange("");
              setOpen(true);
              inputRef.current?.focus();
            }}
          >
            <X size={13} />
          </button>
        ) : (
          <ChevronDown size={12} aria-hidden="true" />
        )}
      </div>
      <span className="player-combobox-selection" id={`${id}-selection`}>
        {value
          ? `Steam ID · ${value}`
          : editing && search
            ? "请从搜索结果中选中玩家"
            : "可搜索本次采集的全部玩家"}
      </span>
      {open && !isDisabled && (
        <div className="player-combobox-popup">
          {pending ? (
            <div className="player-combobox-message" role="status">
              <LoaderCircle className="spin" size={14} /> 正在搜索…
            </div>
          ) : query.isError ? (
            <div
              className="player-combobox-message player-combobox-error"
              role="alert"
            >
              <span>{query.error.message || "搜索暂时不可用"}</span>
              <button type="button" onClick={() => void query.refetch()}>
                重试
              </button>
            </div>
          ) : !players.length ? (
            <div className="player-combobox-message" role="status">
              {queryText
                ? "未找到匹配玩家，试试昵称片段或 Steam ID"
                : "当前没有可选玩家"}
            </div>
          ) : null}
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={`${label}搜索结果`}
            className="player-combobox-options"
          >
            {players.map((player, index) => (
              <button
                key={player.id}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={player.id === value}
                tabIndex={-1}
                className={index === activeIndex ? "active" : undefined}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectPlayer(player)}
              >
                <span className="player-combobox-option-text">
                  <strong>{player.name}</strong>
                  <span>
                    {player.id} · {player.depth} 度
                  </span>
                </span>
                {player.id === value && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
          </div>
          {!pending && !query.isError && players.length > 0 && (
            <div className="player-combobox-count" role="status">
              {total > players.length
                ? `共 ${total.toLocaleString("zh-CN")} 位，显示前 ${players.length} 位，请输入更多文字缩小范围`
                : `找到 ${total.toLocaleString("zh-CN")} 位玩家`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
