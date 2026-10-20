import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { dataDir } from "../lib/storage";

function openDatabase() {
  mkdirSync(dataDir(), { recursive: true });
  const sqlite = new Database(path.join(dataDir(), "platform.sqlite"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 10000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  return { db, sqlite };
}
const databases = new Map<string, ReturnType<typeof openDatabase>>();
export function database() {
  const key = dataDir();
  let value = databases.get(key);
  if (!value) {
    value = openDatabase();
    databases.set(key, value);
  }
  return value;
}
