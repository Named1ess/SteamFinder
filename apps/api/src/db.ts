import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config.js";
import * as schema from "./schema.js";
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 12,
});
export const db = drizzle(pool, { schema });
export async function transaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
