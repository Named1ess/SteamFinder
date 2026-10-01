import { PgBoss } from "pg-boss";
import { config } from "./config.js";
export const boss = new PgBoss({ connectionString: config.databaseUrl });
export const QUEUE = `steamfinder-crawl-${config.mode}`;
export const GAME_QUEUE = `steamfinder-game-scores-${config.mode}`;
boss.on("error", () => console.error("Background queue connection failed"));
export async function startQueue() {
  await boss.start();
  await boss.createQueue(QUEUE, {
    retryLimit: 5,
    retryDelay: 5,
    expireInSeconds: 600,
  });
  await boss.createQueue(GAME_QUEUE, {
    retryLimit: 5,
    retryDelay: 5,
    expireInSeconds: 36000,
  });
}
export async function enqueueGameScores(id: string) {
  await boss.send(
    GAME_QUEUE,
    { id },
    { retryLimit: 5, retryDelay: 5, expireInSeconds: 36000 },
  );
}
export async function enqueue(id: string) {
  await boss.send(
    QUEUE,
    { id },
    { retryLimit: 5, retryDelay: 5, expireInSeconds: 600 },
  );
}
