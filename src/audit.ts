import Database from "better-sqlite3";
import { resolve } from "node:path";

export interface AuditEntry {
  id: number;
  timestamp: string;
  secretName: string;
  reason: string;
  action: "approved" | "denied" | "auto_approved";
  scope: "secret" | "vault";
  ttlExpiresAt: string | null;
}

export class AuditLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private checkSecretTtlStmt: Database.Statement;
  private checkVaultTtlStmt: Database.Statement;

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
        scope TEXT NOT NULL DEFAULT 'secret',
        ttl_expires_at TEXT
      )
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO audit (secret_name, reason, action, scope, ttl_expires_at) VALUES (?, ?, ?, ?, ?)`
    );

    // Check if a specific secret has an active approval
    this.checkSecretTtlStmt = this.db.prepare(
      `SELECT ttl_expires_at FROM audit
       WHERE secret_name = ? AND action IN ('approved', 'auto_approved')
         AND ttl_expires_at > datetime('now')
       ORDER BY ttl_expires_at DESC LIMIT 1`
    );

    // Check if a vault has a vault-wide active approval
    this.checkVaultTtlStmt = this.db.prepare(
      `SELECT ttl_expires_at FROM audit
       WHERE secret_name = ? AND scope = 'vault'
         AND action IN ('approved', 'auto_approved')
         AND ttl_expires_at > datetime('now')
       ORDER BY ttl_expires_at DESC LIMIT 1`
    );
  }

  log(
    secretName: string,
    reason: string,
    action: AuditEntry["action"],
    scope: AuditEntry["scope"] = "secret",
    ttlMinutes?: number
  ): void {
    const ttlExpiresAt = ttlMinutes
      ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      : null;
    this.insertStmt.run(secretName, reason, action, scope, ttlExpiresAt);
  }

  /** Check if this specific secret has an active approval window */
  hasActiveSecretApproval(secretKey: string): boolean {
    const row = this.checkSecretTtlStmt.get(secretKey) as { ttl_expires_at: string } | undefined;
    return !!row;
  }

  /** Check if this vault has an active vault-wide approval window */
  hasActiveVaultApproval(vaultName: string): boolean {
    const row = this.checkVaultTtlStmt.get(vaultName) as { ttl_expires_at: string } | undefined;
    return !!row;
  }

  /** Check if access is permitted — either secret-level or vault-level */
  isPermitted(vaultName: string, secretKey: string): boolean {
    return this.hasActiveVaultApproval(vaultName) || this.hasActiveSecretApproval(secretKey);
  }

  close(): void {
    this.db.close();
  }
}
