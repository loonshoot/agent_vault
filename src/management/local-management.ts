import type { ApprovalServer } from "../approval.js";
import type { AuditLog } from "../audit.js";
import type { WebhookDispatcher, AccessEvent } from "../webhooks.js";
import type { VaultInstance } from "../server.js";
import type {
  AccessGrant,
  AccessRequest,
  ListedGroup,
  ManagementProvider,
  RequesterAttribution,
  ResolvedReadTarget,
  ResolvedWriteTarget,
  SecretBackend,
  UseLog,
} from "./management.js";

/**
 * Management hook wrapping the existing local pieces — the ngrok/HTTP approval
 * server, the SQLite audit log (which doubles as the TTL cache), and the
 * observability webhooks. Behaviour is intentionally bit-identical to the
 * pre-split tool handlers: the same approval label, the same audit rows, the
 * same webhook events fire, in the same order. This is the DEFAULT management
 * hook, used whenever no `outrun` block is present in the config.
 *
 * SECURITY INVARIANT (unchanged): the approval URL and pending-request id are
 * only ever console.error'd / webhook-dispatched — never returned in the
 * AccessGrant, so they can never reach the calling agent.
 */
export class LocalManagement implements ManagementProvider {
  readonly name = "local";

  constructor(
    private approval: ApprovalServer,
    private audit: AuditLog,
    private webhooks: WebhookDispatcher
  ) {}

  async requestAccess(req: AccessRequest): Promise<AccessGrant> {
    if (req.action === "write") return this.requestWriteAccess(req);
    return this.requestReadAccess(req);
  }

  private async requestReadAccess(req: AccessRequest): Promise<AccessGrant> {
    const vault = req.vault ?? "";
    const requester = req.requester ?? {};
    const names = req.secretNames;

    // Partition into already-permitted (active window) and needs-approval —
    // exactly the old get_secrets logic; single get_secret is the 1-element case.
    const needsApproval: string[] = [];
    for (const name of names) {
      const auditKey = `${vault}/${name}`;
      if (!this.audit.isPermitted(vault, auditKey)) needsApproval.push(name);
    }

    if (needsApproval.length === 0) {
      for (const name of names) {
        this.audit.log(`${vault}/${name}`, req.reason, "auto_approved", "secret", undefined, ...this.who(requester));
      }
      this.webhooks.dispatch(accessEvent(vault, names, req.reason, "auto_approved", "secret", undefined, requester));
      return { granted: true, autoApproved: true };
    }

    const label =
      needsApproval.length === 1
        ? `${vault} / ${needsApproval[0]}`
        : `${vault} / ${needsApproval.length} secrets: ${needsApproval.join(", ")}`;

    const { url, waitForApproval } = this.approval.requestApproval(label, req.reason, {
      action: "read",
      vault,
      secrets: needsApproval,
      requesterId: requester.requesterId,
      taskId: requester.taskId,
      branch: requester.branch,
    });
    console.error(`\n🔒 Approve access to [${needsApproval.join(", ")}] from vault "${vault}": ${url}\n`);

    const approved = await waitForApproval;
    if (!approved) {
      for (const name of needsApproval) {
        this.audit.log(`${vault}/${name}`, req.reason, "denied", "secret", undefined, ...this.who(requester));
      }
      this.webhooks.dispatch(accessEvent(vault, needsApproval, req.reason, "denied", "secret", undefined, requester));
      return { granted: false, denialReason: "denied" };
    }

    const scope = req.ttlScope ?? "secret";
    const ttl = req.ttlMinutes || undefined;
    if (scope === "vault") {
      this.audit.log(vault, req.reason, "approved", "vault", ttl, ...this.who(requester));
    } else {
      for (const name of needsApproval) {
        this.audit.log(`${vault}/${name}`, req.reason, "approved", "secret", ttl, ...this.who(requester));
      }
    }
    this.webhooks.dispatch(accessEvent(vault, needsApproval, req.reason, "approved", scope, ttl, requester));
    return { granted: true };
  }

  private async requestWriteAccess(req: AccessRequest): Promise<AccessGrant> {
    const vault = req.vault ?? "";
    const requester = req.requester ?? {};
    const names = req.secretNames;

    const label =
      names.length === 1
        ? `${vault} / ${names[0]}`
        : `${vault} / ${names.length} secrets: ${names.join(", ")}`;

    const { url, waitForApproval } = this.approval.requestApproval(label, req.reason, {
      action: "write",
      maskedValue: req.maskedValue,
      vault,
      secrets: names,
      requesterId: requester.requesterId,
      taskId: requester.taskId,
      branch: requester.branch,
    });
    console.error(`\n🔒 Approve WRITE of [${names.join(", ")}] to vault "${vault}": ${url}\n`);

    const approved = await waitForApproval;
    if (!approved) {
      for (const name of names) {
        this.audit.log(`${vault}/${name}`, req.reason, "denied", "secret", undefined, ...this.who(requester));
      }
      this.webhooks.dispatch(writeEvent(vault, names, req.reason, "denied", requester));
      return { granted: false, denialReason: "denied" };
    }

    for (const name of names) {
      this.audit.log(`${vault}/${name}`, req.reason, "approved", "secret", undefined, ...this.who(requester));
    }
    this.webhooks.dispatch(writeEvent(vault, names, req.reason, "approved", requester));
    return { granted: true };
  }

  /** Local mode records the decision at grant time — a use adds nothing further. */
  async logUse(_use: UseLog): Promise<void> {
    /* no-op */
  }

  private who(r: RequesterAttribution): [string | undefined, string | undefined, string | undefined] {
    return [r.requesterId, r.taskId, r.branch];
  }
}

/**
 * Local secret backend: multiple named vaults, each with its own SecretProvider,
 * value always read from that local provider. Management is LocalManagement.
 */
export class LocalBackend implements SecretBackend {
  constructor(private vaults: VaultInstance[], readonly management: LocalManagement) {}

  async list(): Promise<ListedGroup[]> {
    const groups: ListedGroup[] = [];
    for (const vault of this.vaults) {
      const secrets = await vault.provider.listSecrets();
      if (secrets.length === 0) continue;
      groups.push({
        group: vault.name,
        secrets: secrets.map((s) => ({ name: s.name, note: s.group })),
      });
    }
    return groups;
  }

  ttlFor(vaultName: string | undefined): { ttlMinutes: number; ttlScope: "secret" | "vault" } {
    const v = this.vaults.find((v) => v.name === vaultName);
    return { ttlMinutes: v?.ttlMinutes ?? 0, ttlScope: v?.ttlScope ?? "secret" };
  }

  // resolveRead validates the vault only (not the secret name), matching the
  // legacy findVault-before-approval behaviour — an unknown secret name still
  // surfaces as a not-found AFTER approval, from the provider read.
  async resolveRead(vaultName: string | undefined, name: string): Promise<ResolvedReadTarget> {
    const vault = this.requireVault(vaultName);
    return { provider: vault.provider, readId: name, logsUseInternally: false };
  }

  resolveWrite(vaultName: string | undefined, name: string): ResolvedWriteTarget {
    const vault = this.requireVault(vaultName);
    if (!vault.writable) {
      throw new Error(`Vault "${vaultName}" is not writable. Set "writable": true in your config to enable writes.`);
    }
    if (!vault.provider.setSecret) {
      throw new Error(`Provider "${vault.provider.name}" does not support writing secrets.`);
    }
    return { provider: vault.provider, writeId: name };
  }

  private requireVault(vaultName: string | undefined): VaultInstance {
    const vault = this.vaults.find((v) => v.name === vaultName);
    if (!vault) {
      throw new Error(
        `Vault "${vaultName}" not found. Available: ${this.vaults.map((v) => v.name).join(", ")}`
      );
    }
    return vault;
  }
}

// ── Webhook event builders (moved verbatim from server.ts) ─────────────────

function accessEvent(
  vault: string,
  secrets: string[],
  reason: string,
  action: AccessEvent["action"],
  scope: AccessEvent["scope"],
  ttlMinutes: number | undefined,
  requester: RequesterAttribution
): AccessEvent {
  return {
    timestamp: new Date().toISOString(),
    vault,
    secrets,
    reason,
    action,
    scope,
    ttlExpiresAt: ttlMinutes ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null,
    requesterId: requester.requesterId,
    taskId: requester.taskId,
    branch: requester.branch,
  };
}

function writeEvent(
  vault: string,
  secrets: string[],
  reason: string,
  action: "approved" | "denied",
  requester: RequesterAttribution
): AccessEvent {
  return {
    timestamp: new Date().toISOString(),
    vault,
    secrets,
    reason,
    action,
    scope: "secret",
    ttlExpiresAt: null,
    requesterId: requester.requesterId,
    taskId: requester.taskId,
    branch: requester.branch,
  };
}
