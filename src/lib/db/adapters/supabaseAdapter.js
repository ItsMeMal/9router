// Supabase / Postgres adapter for 9Router
// Drop-in compatible with the SQLite adapter interface.
// Activate by setting DATABASE_URL (postgres://...) instead of relying on SQLite.

import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.SUPABASE_DB_URL && process.env.SUPABASE_DB_URL !== "disable"
    ? { rejectUnauthorized: false }
    : process.env.DATABASE_URL?.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/** @returns {Promise<import("./adapter.js").DbAdapter>} */
export async function createSupabaseAdapter() {
  // Health check
  await pool.query("SELECT 1");

  return {
    driver: "supabase-postgres",

    // --- Schema & migration (no-ops — handled by Supabase migrations) ---
    run: async () => {},
    prepare: async (sql, params) => ({ run: async () => {} }),

    // --- Queries ---
    all: async (sql, params = []) => {
      const result = sqlToParams(sql, params);
      const res = await pool.query(result.sql, result.params);
      return res.rows;
    },

    get: async (sql, params = []) => {
      const result = sqlToParams(sql, params);
      const res = await pool.query(result.sql, [...result.params, ...(result.limited ? [] : [])]);
      // Re-query with LIMIT if needed
      if (!result.limited) {
        const res2 = await pool.query(result.sql + " LIMIT 1", result.params);
        return res2.rows[0] || null;
      }
      return res.rows[0] || null;
    },

    run: async (sql, params = []) => {
      const result = sqlToParams(sql, params);
      const res = await pool.query(result.sql, result.params);
      return { lastID: res.rowCount || 0, changes: res.rowCount || 0 };
    },

    // --- Transactions ---
    transaction: (fn) => {
      return new Promise(async (resolve, reject) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Wrap the SQLite-style db.run/all/get calls inside this transaction
          const tx = {
            run: async (sql, params = []) => {
              const result = sqlToParams(sql, params);
              return client.query(result.sql, result.params);
            },
            all: async (sql, params = []) => {
              const result = sqlToParams(sql, params);
              const res = await client.query(result.sql, result.params);
              return res.rows;
            },
            get: async (sql, params = []) => {
              const result = sqlToParams(sql, params);
              const res = await client.query(result.sql + " LIMIT 1", result.params);
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

    // Expose raw pool for advanced queries
    raw: pool,
  };
}

/**
 * Convert SQLite-style SQL to Postgres-compatible SQL.
 * Handles ?, ON CONFLICT, and LIMIT clauses.
 * Returns { sql, params, limited }
 */
function sqlToParams(sql, params) {
  let pgSql = sql;
  const pgParams = [...params];

  // Detect if SQL has LIMIT already
  const limited = /LIMIT\s+\d+/i.test(sql);

  // Convert SQLite-style ? to Postgres $1, $2, ...
  let paramIndex = 1;
  pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

  // Handle SQLite "ON CONFLICT(id) DO UPDATE SET ... = excluded.column"
  // Postgres supports this syntax natively, so no change needed.

  // Handle SQLite-style INSERT OR REPLACE → Postgres UPSERT
  pgSql = pgSql.replace(/INSERT OR REPLACE INTO/gi, "INSERT INTO");

  // Handle IF NOT EXISTS (CREATE TABLE) — Postgres doesn't support inline IF NOT EXISTS on all operations
  // But CREATE TABLE IF NOT EXISTS is supported in Postgres 9.1+

  // Convert AUTOINCREMENT
  pgSql = pgSql.replace(/AUTOINCREMENT/gi, "SERIAL");

  // Handle TINYINT, UNSIGNED (unsupported in Postgres) — map to INTEGER
  pgSql = pgSql.replace(/TINYINT\b/gi, "INTEGER");
  pgSql = pgSql.replace(/UNSIGNED\s+INTEGER/gi, "INTEGER");

  // Handle DATETIME default
  pgSql = pgSql.replace(/DEFAULT\s+CURRENT_TIMESTAMP/gi, "DEFAULT NOW()");

  // Handle BOOLEAN as INTEGER (SQLite) → BOOLEAN (Postgres)
  pgSql = pgSql.replace(/isActive\s+INTEGER/gi, "is_active BOOLEAN");

  return { sql: pgSql, params: pgParams, limited };
}
