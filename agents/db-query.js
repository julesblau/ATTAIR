#!/usr/bin/env node
/**
 * SQL Access for Claude CLI / Agents
 * ───────────────────────────────────
 * Usage:
 *   node agents/db-query.js "SELECT count(*) FROM scans"
 *   node agents/db-query.js "SELECT * FROM users LIMIT 5"
 *
 * Env vars needed (in agents/.env or system env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * The service role key bypasses RLS for full read/write access.
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from agents/.env first, then backend/.env as fallback
config({ path: join(__dirname, ".env") });
config({ path: join(__dirname, "..", "attair-backend", ".env") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  console.error("Add them to agents/.env or attair-backend/.env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error("Usage: node db-query.js \"SELECT ...\"");
  process.exit(1);
}

// Safety: warn on destructive queries
const destructive = /^\s*(DROP|TRUNCATE|DELETE\s+FROM\s+\w+\s*$)/i;
if (destructive.test(query)) {
  console.error("Blocked: destructive query without WHERE clause. Add --force to override.");
  if (!process.argv.includes("--force")) process.exit(1);
}

try {
  const { data, error } = await supabase.rpc("exec_sql", { query_text: query });

  if (error) {
    // Fallback: use the REST API for simple selects
    // supabase.rpc('exec_sql') requires a custom function — try direct table query
    if (error.message?.includes("exec_sql")) {
      console.error("The exec_sql function is not set up in Supabase yet.");
      console.error("Run this SQL in your Supabase SQL Editor to enable it:");
      console.error("");
      console.error("  CREATE OR REPLACE FUNCTION exec_sql(query_text text)");
      console.error("  RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$");
      console.error("  DECLARE result json;");
      console.error("  BEGIN");
      console.error("    EXECUTE query_text INTO result;");
      console.error("    RETURN result;");
      console.error("  END; $$;");
      console.error("");
      console.error("Then retry your query.");
      process.exit(1);
    }
    console.error("Query error:", error.message);
    process.exit(1);
  }

  if (Array.isArray(data)) {
    console.table(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
