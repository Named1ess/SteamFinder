import {
  DEFAULT_ROOT,
  type DataMode,
} from "../../../packages/shared/src/index.js";

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    `postgres://${encodeURIComponent(process.env.PGUSER ?? "steamfinder")}:${encodeURIComponent(process.env.PGPASSWORD ?? "steamfinder")}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${encodeURIComponent(process.env.PGDATABASE ?? "steamfinder")}`,
  mode: (process.env.STEAM_MODE === "live" ? "live" : "demo") as DataMode,
  apiKey: process.env.STEAM_API_KEY ?? "",
  port: Number(process.env.API_PORT ?? 3001),
  delay:
    process.env.STEAM_MODE === "live"
      ? Number(process.env.STEAM_REQUEST_DELAY_MS ?? 350)
      : 20,
  dailyLimit: Number(process.env.DAILY_REQUEST_LIMIT ?? 90000),
  defaultRoot: DEFAULT_ROOT,
};
