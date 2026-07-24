import type { SecretProvider } from "../providers/provider.js";

/**
 * Agent Vault splits into two INDEPENDENTLY PLUGGABLE hooks:
 *
 *   - SecretProvider (providers/provider.ts) — WHERE values live (env / 1Password
 *     / Outrun). Unchanged interface.
 *   - ManagementProvider (this file)         — WHO approves, audits, and revokes.
 *
 * The two compose freely. Today's PoC is `local` management over an env/1Password
 * SecretProvider. Pointing management at Outrun (while leaving the SecretProvider
 * as 1Password) gives the "hybrid" mode: the existing vault keeps the values,
 * Outrun runs HITL approval / audit / revocation in front of it. Storing values
 * in Outrun too gives "full-remote".
 */

export interface RequesterAttribution {
  /** Identity of the requesting worker/agent, shown to the approver. */
  requesterId?: string;
  /** Task or job identifier the request is on behalf of. */
  taskId?: string;
  /** Branch or workspace identifier. */
  branch?: string;
}

export interface AccessRequest {
  /** Local-mode vault name (the MCP `vault` arg). Absent in Outrun mode. */
  vault?: string;
  /** One or more secret names. A batch is presented as a SINGLE approval by local management. */
  secretNames: string[];
  /** The agent's stated reason / purpose, shown to the approver and logged. */
  reason: string;
  /** Requested approval-window length. Local uses it for the audit TTL; Outrun passes it to the server, which clamps per policy. */
  ttlMinutes?: number;
  /** Local TTL scope (secret vs whole vault). Ignored by Outrun (server owns policy). */
  ttlScope?: "secret" | "vault";
  action: "read" | "write";
  /** Masked preview of a value, for write approvals. */
  maskedValue?: string;
  requester?: RequesterAttribution;
}

/** Per-secret routing/grant detail returned alongside a grant (populated by Outrun; empty for local). */
export interface SecretGrantDetail {
  grantId?: string;
  /** Where this secret's value lives — decides read routing. */
  storage?: "outrun" | "external";
  /** For storage='external': which local SecretProvider (by provider type) reads the value. */
  externalProvider?: string;
  /** For storage='external': the item id/name to pass to that local provider. */
  externalItem?: string;
}

export interface AccessGrant {
  /** True once EVERY requested secret is granted. */
  granted: boolean;
  /** Set when the whole request was served from an active window without a fresh approval. */
  autoApproved?: boolean;
  /** Human-readable reason a request was refused (denied / timeout / revoked). */
  denialReason?: string;
  /**
   * Per-secret grant detail keyed by secret name. Populated by Outrun management
   * (grant id + storage routing); left undefined by local management, which does
   * not need per-secret detail to read a locally-held value.
   */
  perSecret?: Record<string, SecretGrantDetail>;
}

export interface UseLog {
  grantId?: string;
  vault?: string;
  secretName: string;
  reason: string;
  requester?: RequesterAttribution;
}

/** Field structure of a managed secret — plaintext manifest, never values. */
export interface ManagedFieldMeta {
  key: string;
  type?: string;
  description?: string;
  sensitive?: boolean;
}

/** Item-level metadata an agent can see BEFORE any grant exists. */
export interface ManagedSecretMeta {
  id: string;
  name: string;
  description?: string;
  urls?: string[];
  fields?: ManagedFieldMeta[];
  storage: "outrun" | "external";
  status?: string;
  /** Grouping label for list output (mount display name for external items). */
  group?: string;
  /** For storage='external': provider type of the mount that holds the value. */
  externalProvider?: string;
  /** For storage='external': the item id/name within the mount. */
  externalItem?: string;
}

export interface ManagementProvider {
  readonly name: string;

  /**
   * BLOCKING. Resolve access for one-or-many secrets. Encapsulates the local
   * approval-page wait AND the Outrun request→poll loop. Returns once granted,
   * denied, or timed out — never leaks an approval URL/id to the caller.
   */
  requestAccess(req: AccessRequest): Promise<AccessGrant>;

  /**
   * Record a USE of an already-granted secret. In hybrid (external) mode this is
   * called BEFORE the local provider read and MUST throw if access was revoked
   * or denied server-side, so the caller does not read locally. Local management
   * is a no-op (it records the decision at grant time).
   */
  logUse(use: UseLog): Promise<void>;

  /** Optional list-output augmentation (Outrun items the local providers don't know about). */
  listAvailable?(): Promise<ManagedSecretMeta[]>;

  stop?(): Promise<void>;
}

// ── Secret backend seam ───────────────────────────────────────────────────
//
// A SecretBackend bundles a ManagementProvider with the routing needed to turn
// a secret name into a concrete read/write. Two implementations exist:
//   - LocalBackend  — multi-vault, value always in a local provider.
//   - OutrunBackend — per-secret routing (outrun-stored vs mounted external).
// server.ts is mode-agnostic: it drives whichever backend it is handed.

export interface ResolvedReadTarget {
  provider: SecretProvider;
  readId: string;
  /**
   * True when provider.getSecret already records the use server-side
   * (Outrun-stored reads go through readSecretFields). The caller then SKIPS
   * management.logUse. False for local vaults and mounted external secrets,
   * where the caller must logUse before reading.
   */
  logsUseInternally: boolean;
}

export interface ResolvedWriteTarget {
  provider: SecretProvider;
  writeId: string;
}

export interface ListedGroup {
  group: string;
  secrets: { name: string; note?: string; description?: string }[];
}

export interface SecretBackend {
  readonly management: ManagementProvider;
  /** Enumerate available secrets (names/notes only) for list_secrets. */
  list(): Promise<ListedGroup[]>;
  /** Default approval window for a vault (local); Outrun returns a config default. */
  ttlFor(vault: string | undefined): { ttlMinutes: number; ttlScope: "secret" | "vault" };
  /**
   * Resolve where to READ a secret. Runs BEFORE requestAccess so that a missing
   * vault/secret is reported without opening an approval (matching legacy
   * findVault-before-approval). Throws with an agent-readable message if the
   * target cannot be resolved.
   */
  resolveRead(vault: string | undefined, name: string): Promise<ResolvedReadTarget>;
  /** Resolve where to WRITE a secret. Throws if writes are unsupported/disabled. */
  resolveWrite(vault: string | undefined, name: string): ResolvedWriteTarget;
}
