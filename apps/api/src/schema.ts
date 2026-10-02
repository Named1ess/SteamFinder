import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  primaryKey,
  date,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const players = pgTable(
  "players",
  {
    mode: text("mode").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    avatar: text("avatar"),
    profileUrl: text("profile_url").notNull(),
    summaryAt: time("summary_at"),
  },
  (t) => [primaryKey({ columns: [t.mode, t.id] })],
);
export const friendLists = pgTable(
  "friend_lists",
  {
    mode: text("mode").notNull(),
    ownerId: text("owner_id").notNull(),
    fetchedAt: time("fetched_at"),
    attemptedAt: time("attempted_at"),
    status: text("status").notNull().default("unknown"),
    friendCount: integer("friend_count"),
  },
  (t) => [primaryKey({ columns: [t.mode, t.ownerId] })],
);
export const observations = pgTable(
  "friend_observations",
  {
    mode: text("mode").notNull(),
    ownerId: text("owner_id").notNull(),
    friendId: text("friend_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.ownerId, t.friendId] })],
);
export const edges = pgTable(
  "friendship_edges",
  {
    mode: text("mode").notNull(),
    source: text("source").notNull(),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.source, t.target] })],
);
export const runs = pgTable("crawl_runs", {
  id: uuid("id").primaryKey(),
  rootId: text("root_id").notNull(),
  mode: text("mode").notNull(),
  depth: integer("depth").notNull(),
  maxNodes: integer("max_nodes").notNull(),
  maxRequests: integer("max_requests").notNull(),
  status: text("status").notNull().default("queued"),
  requestCount: integer("request_count").notNull().default(0),
  cacheHits: integer("cache_hits").notNull().default(0),
  refresh: boolean("refresh").notNull().default(false),
  message: text("message"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  completedAt: time("completed_at"),
});
export const runNodes = pgTable(
  "run_nodes",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    depth: integer("depth").notNull(),
    expanded: boolean("expanded").notNull().default(false),
    observed: boolean("observed").notNull().default(false),
    hydrated: boolean("hydrated").notNull().default(false),
    fetchStatus: text("fetch_status").notNull().default("unknown"),
    fetchedAt: time("fetched_at"),
    friendCount: integer("friend_count"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.playerId] })],
);
export const runObservations = pgTable(
  "run_friend_observations",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    friendId: text("friend_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ownerId, t.friendId] }),
    index("run_observations_friend").on(t.runId, t.friendId),
  ],
);
export const runEdges = pgTable(
  "run_edges",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    target: text("target").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.source, t.target] }),
    index("run_edges_target").on(t.runId, t.target),
  ],
);
export const budgets = pgTable("request_budgets", {
  mode: text("mode").primaryKey(),
  day: date("day").notNull(),
  requests: integer("requests").notNull().default(0),
  lastCall: time("last_call").notNull(),
});
export const vanityResolutions = pgTable(
  "vanity_resolutions",
  {
    mode: text("mode").notNull(),
    vanity: text("vanity").notNull(),
    playerId: text("player_id").notNull(),
    resolvedAt: time("resolved_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.mode, t.vanity] })],
);
export const gameProfiles = pgTable(
  "game_profiles",
  {
    mode: text("mode").notNull(),
    playerId: text("player_id").notNull(),
    status: text("status").notNull().default("unknown"),
    scope: text("scope").notNull().default("profile_recent"),
    games: jsonb("games").notNull().default([]),
    profile: jsonb("profile"),
    fetchedAt: time("fetched_at"),
    attemptedAt: time("attempted_at"),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.mode, t.playerId] })],
);
export const gameScoreJobs = pgTable("game_score_jobs", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  rootId: text("root_id").notNull(),
  status: text("status").notNull().default("queued"),
  refresh: boolean("refresh").notNull().default(false),
  maxRequests: integer("max_requests").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  cacheHits: integer("cache_hits").notNull().default(0),
  message: text("message"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  completedAt: time("completed_at"),
});
export const gameScorePlayers = pgTable(
  "game_score_players",
  {
    jobId: uuid("job_id").notNull().references(() => gameScoreJobs.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    isRoot: boolean("is_root").notNull().default(false),
    name: text("name").notNull(),
    avatar: text("avatar"),
    profileUrl: text("profile_url").notNull(),
    processed: boolean("processed").notNull().default(false),
    status: text("status").notNull().default("unknown"),
    scope: text("scope").notNull().default("profile_recent"),
    games: jsonb("games").notNull().default([]),
    profile: jsonb("profile"),
    fetchedAt: time("fetched_at"),
    attemptedAt: time("attempted_at"),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.playerId] })],
);
export const playerDetails = pgTable(
  "player_details",
  {
    mode: text("mode").notNull(),
    playerId: text("player_id").notNull(),
    profile: jsonb("profile"),
    profileStatus: text("profile_status").notNull().default("unknown"),
    profileFetchedAt: time("profile_fetched_at"),
    profileAttemptedAt: time("profile_attempted_at"),
    profileMessage: text("profile_message"),
    aliases: jsonb("aliases").notNull().default([]),
    aliasesStatus: text("aliases_status").notNull().default("unknown"),
    aliasesFetchedAt: time("aliases_fetched_at"),
    aliasesAttemptedAt: time("aliases_attempted_at"),
    aliasesMessage: text("aliases_message"),
  },
  (t) => [primaryKey({ columns: [t.mode, t.playerId] })],
);
export const groupProfiles = pgTable(
  "group_profiles",
  {
    mode: text("mode").notNull(),
    playerId: text("player_id").notNull(),
    status: text("status").notNull().default("unknown"),
    groups: jsonb("groups").notNull().default([]),
    totalCount: integer("total_count"),
    complete: boolean("complete").notNull().default(false),
    fetchedAt: time("fetched_at"),
    attemptedAt: time("attempted_at"),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.mode, t.playerId] })],
);
export const groupCollectionJobs = pgTable("group_collection_jobs", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  rootId: text("root_id").notNull(),
  status: text("status").notNull().default("queued"),
  refresh: boolean("refresh").notNull().default(false),
  maxRequests: integer("max_requests").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  cacheHits: integer("cache_hits").notNull().default(0),
  message: text("message"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
  completedAt: time("completed_at"),
});
export const groupCollectionPlayers = pgTable(
  "group_collection_players",
  {
    jobId: uuid("job_id").notNull().references(() => groupCollectionJobs.id, { onDelete: "cascade" }),
    playerId: text("player_id").notNull(),
    isRoot: boolean("is_root").notNull().default(false),
    depth: integer("depth").notNull(),
    processed: boolean("processed").notNull().default(false),
    status: text("status").notNull().default("unknown"),
    groups: jsonb("groups").notNull().default([]),
    totalCount: integer("total_count"),
    complete: boolean("complete").notNull().default(false),
    fetchedAt: time("fetched_at"),
    attemptedAt: time("attempted_at"),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.playerId] })],
);
