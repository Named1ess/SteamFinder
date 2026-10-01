import { readFile } from "node:fs/promises";
import { pool } from "./db.js";
try {
  await pool.query(
    await readFile(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  console.log("SteamFinder database migrated");
} finally {
  await pool.end();
}
