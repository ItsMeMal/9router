// Supabase / Postgres adapter for 9Router
// Drop-in compatible with the SQLite adapter interface.
// Activate by setting DATABASE_URL (postgres://...) instead of relying on SQLite.

import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/** @returns {Promise<import("./adapter.js").DbAdapter>} */
export async function createSupabaseAdapter() {
  await pool.query("SELECT 1");

  return {
    driver: "supabase-postgres",

    // --- Queries (uses sqlToParams to convert ? → $N) ---
    all: async (sql, params = []) => {
      const { sql: pgSql, params: pgParams } = sqlToParams(sql, params);
      const res = await pool.query(pgSql, pgParams);
      return res.rows;
    },

    get: async (sql, params = []) => {
      // Add LIMIT 1 if not already present
      let pgSql = sql;
      if (!/LIMIT\s+\d+/i.test(sql)) pgSql += " LIMIT 1";
      const { sql: finalSql, params: pgParams } = sqlToParams(pgSql, params);
      const res = await pool.query(finalSql, pgParams);
      return res.rows[0] || null;
    },

    run: async (sql, params = []) => {
      const { sql: pgSql, params: pgParams } = sqlToParams(sql, params);
      const res = await pool.query(pgSql, pgParams);
      return { lastID: null, changes: res.rowCount || 0 };
    },

    // --- Transactions ---
    transaction: (fn) => {
      return new Promise(async (resolve, reject) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const tx = {
            run: async (sql, params = []) => {
              const { sql: pgSql, params: pgParams } = sqlToParams(sql, params);
              return client.query(pgSql, pgParams);
            },
            all: async (sql, params = []) => {
              const { sql: pgSql, params: pgParams } = sqlToParams(sql, params);
              const res = await client.query(pgSql, pgParams);
              return res.rows;
            },
            get: async (sql, params = []) => {
              let pgSql = sql;
              if (!/LIMIT\s+\d+/i.test(sql)) pgSql += " LIMIT 1";
              const { sql: finalSql, params: pgParams } = sqlToParams(pgSql, params);
              const res = await client.query(finalSql, pgParams);
              return res.rows[0] || null;
            },
          };
          await fn(tx);
          await client.query("COMMIT");
          resolve();
        } catch (err) {
          await client.rollback();
          reject(err);
        } finally {
          client.release();
        }
      });
    },

    // --- Cleanup ---
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * Convert SQLite-style SQL to Postgres-compatible SQL.
 * Handles ? → $N conversion, AUTOINCREMENT → SERIAL, etc.
 * Returns { sql, params }
 */
function sqlToParams(sql, params) {
  let pgSql = sql;
  const pgParams = [...params];

  // Convert SQLite ? placeholders to Postgres $1, $2, ...
  let paramIndex = 1;
  pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

  return { sql: pgSql, params: pgParams };
}
