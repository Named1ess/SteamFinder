import {
  DEFAULT_ROOT,
  type DataMode,
} from "../../../packages/shared/src/index.js";

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    `postgres://${encodeURIComponent(process.env.PGUSER ?? "steamfinder")}:${encodeURIComponent(process.env.PGPASSWORD ?? "steamfinder")}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}/${encodeURIComponent(process.env.PGDATABASE ?? "steamfinder")}`,
  mode: (process.env.STEAM_MODE === "demo" ? "demo" : "live") as DataMode,
  port: Number(process.env.API_PORT ?? 3001),
  delay:
    process.env.STEAM_MODE === "demo"
      ? 20
      : Number(process.env.STEAM_REQUEST_DELAY_MS ?? 2000),
  dailyLimit: Number(process.env.DAILY_REQUEST_LIMIT ?? 10000),
  defaultRoot: DEFAULT_ROOT,
};
