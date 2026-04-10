import Database from "better-sqlite3";
import { resolve } from "node:path";

export interface AuditEntry {
  id: number;
  timestamp: string;
  secretName: string;
  reason: string;
  action: "approved" | "denied" | "auto_approved";
  ttlExpiresAt: string | null;
}

export class AuditLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private checkTtlStmt: Database.Statement;

  constructor(dbPath: string = "agent-vault.db") {
    this.db = new Database(resolve(dbPath));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        secret_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        action TEXT NOT NULL,
        ttl_expires_at TEXT
      )
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO audit (secret_name, reason, action, ttl_expires_at) VALUES (?, ?, ?, ?)`
    );
    this.checkTtlStmt = this.db.prepare(
      `SELECT ttl_expires_at FROM audit
       WHERE secret_name = ? AND action IN ('approved', 'auto_approved')
         AND ttl_expires_at > datetime('now')
       ORDER BY ttl_expires_at DESC LIMIT 1`
    );
  }

  log(secretName: string, reason: string, action: AuditEntry["action"], ttlMinutes?: number): void {
    const ttlExpiresAt = ttlMinutes
      ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      : null;
    this.insertStmt.run(secretName, reason, action, ttlExpiresAt);
  }

  /** Check if this secret has an active TTL approval window */
  hasActiveApproval(secretName: string): boolean {
    const row = this.checkTtlStmt.get(secretName) as { ttl_expires_at: string } | undefined;
    return !!row;
  }

  close(): void {
    this.db.close();
  }
}
