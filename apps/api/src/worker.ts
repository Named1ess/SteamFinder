import { pool } from "./db.js";
import { config } from "./config.js";
import { DemoProvider, PublicWebProvider } from "./provider.js";
import { crawl } from "./crawler.js";
import { boss, startQueue, enqueue, QUEUE } from "./queue.js";
const provider =
  config.mode === "demo" ? new DemoProvider() : new PublicWebProvider();
await startQueue();
// A process that died between DB progress and job acknowledgement is safe to replay.
const recover = await pool.query(
  `SELECT id FROM crawl_runs WHERE mode=$1 AND status IN ('queued','running')`,
  [config.mode],
);
for (const row of recover.rows) await enqueue(row.id);
await boss.work<{ id: string }>(
  QUEUE,
  { pollingIntervalSeconds: 0.5, batchSize: 1 },
  async (jobs) => {
    for (const job of jobs) await crawl(job.data.id, provider);
  },
);
console.log(`SteamFinder worker ready (${config.mode})`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await boss.stop({ graceful: true, timeout: 20000 });
    await pool.end();
    process.exit(0);
  });
