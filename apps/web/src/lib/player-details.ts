import type { PlayerDetailsSnapshot } from "../../../../packages/shared/src/index";
import { api } from "./api";

export async function loadPlayerDetails(
  playerId: string,
  read: (id: string) => Promise<PlayerDetailsSnapshot> = api.playerDetails,
  collect: (
    id: string,
    refresh: boolean,
  ) => Promise<PlayerDetailsSnapshot> = api.collectPlayerDetails,
): Promise<PlayerDetailsSnapshot> {
  const cached = await read(playerId);
  return cached.profileStatus === "unknown" ||
    cached.aliasesStatus === "unknown"
    ? collect(playerId, false)
    : cached;
}

export interface ProfileAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export function profileCardPosition(
  anchor: ProfileAnchor,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const margin = 12;
  const gap = 12;
  const preferredLeft =
    anchor.right + gap + width <= viewportWidth - margin
      ? anchor.right + gap
      : anchor.left - gap - width;
  return {
    left: Math.max(
      margin,
      Math.min(preferredLeft, viewportWidth - width - margin),
    ),
    top: Math.max(
      margin,
      Math.min(anchor.top, viewportHeight - height - margin),
    ),
  };
}
