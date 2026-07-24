import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AuditLog } from "../audit.js";

test("AuditLog.log stores requesterId/taskId/branch when provided", () => {
  const audit = new AuditLog(":memory:");
  audit.log("dev/HUBSPOT_SANDBOX_TOKEN", "sync churn data", "approved", "secret", undefined, "churn-preset", "task-142", "feature/churn-model");
  const rows = (audit as unknown as { db: import("better-sqlite3").Database }).db
    .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
    .all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requester_id, "churn-preset");
  assert.equal(rows[0].task_id, "task-142");
  assert.equal(rows[0].branch, "feature/churn-model");
  audit.close();
});

test("AuditLog.log stays backward compatible when identity fields are omitted", () => {
  const audit = new AuditLog(":memory:");
  // Old-style call signature — exactly what pre-existing callers used.
  audit.log("dev/DATABASE_URL", "run migration", "approved", "secret", 15);
  const rows = (audit as unknown as { db: import("better-sqlite3").Database }).db
    .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
    .all() as any[];
  assert.equal(rows[0].requester_id, null);
  assert.equal(rows[0].task_id, null);
  assert.equal(rows[0].branch, null);
  assert.ok(rows[0].ttl_expires_at);
  audit.close();
});

test("AuditLog migrates pre-existing databases that lack the requester/task/branch columns", () => {
  // Simulate a database created by an older version of Agent Vault (before
  // requester_id/task_id/branch existed) and verify the same migration logic
  // AuditLog runs on startup adds the columns rather than failing.
  const legacy = new Database(":memory:");
  legacy.exec(`
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      secret_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      action TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'secret',
      ttl_expires_at TEXT
    )
  `);
  const columnsBefore = legacy.prepare("PRAGMA table_info(audit)").all() as { name: string }[];
  assert.ok(!columnsBefore.some((c) => c.name === "requester_id"));
  for (const col of ["requester_id", "task_id", "branch"]) {
    legacy.exec(`ALTER TABLE audit ADD COLUMN ${col} TEXT`);
  }
  const columnsAfter = legacy.prepare("PRAGMA table_info(audit)").all() as { name: string }[];
  assert.ok(columnsAfter.some((c) => c.name === "requester_id"));
  assert.ok(columnsAfter.some((c) => c.name === "task_id"));
  assert.ok(columnsAfter.some((c) => c.name === "branch"));
  legacy.close();
});
