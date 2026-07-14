import type { SecretProvider } from "../providers/provider.js";
import { OutrunSecretsProvider } from "../providers/outrun-provider.js";
import type { OutrunClient, OutrunMount, OutrunSecretMeta } from "../outrun/client.js";
import type {
  AccessGrant,
  AccessRequest,
  ListedGroup,
  ManagedSecretMeta,
  ManagementProvider,
  ResolvedReadTarget,
  ResolvedWriteTarget,
  SecretBackend,
  UseLog,
} from "./management.js";

export interface OutrunManagementOptions {
  /** Poll interval while waiting for a standalone approval to resolve (default 3000ms). */
  pollIntervalMs?: number;
  /** Give up waiting for approval after this long (default 15 min). */
  timeoutMs?: number;
  /** Default requested TTL when the agent doesn't specify one (0/undefined → server policy default). */
  defaultTtlMinutes?: number;
}

interface CachedGrant {
  grantId: string;
  /** epoch ms; the grant is reused without a fresh approval until this passes. */
  expiresAt: number;
}

/** Resolution of a single acquired grant that reached `active`. */
interface AcquiredGrant {
  grantId: string;
  /** epoch ms expiry, or null when the server returned no expiry. */
  expiresAt: number | null;
}

/**
 * A non-active terminal state (denied/revoked/expired/timeout) thrown out of the
 * shared in-flight promise so every concurrent waiter on it gets the same clean
 * denial. `status` is the terminal grant status for the caller's denialReason.
 */
class GrantNotApprovedError extends Error {
  constructor(readonly status: string) {
    super(`grant ${status}`);
    this.name = "GrantNotApprovedError";
  }
}

const TERMINAL = new Set(["active", "denied", "revoked", "expired"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseExpiry(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? null : t;
}

/**
 * Management hook backed by Outrun. Approval, audit, and revocation all live
 * server-side — there is NO ngrok/approval server and NO local SQLite decision
 * record in this mode (the local audit DB, if configured, stays only as a
 * secondary trace). `requestAccess` drives the standalone flow: request a grant,
 * then POLL `secretGrant` until it resolves (the human approves anywhere — phone,
 * email reply, Loops, Action Centre). An unexpired grant is reused from an
 * in-process cache without a fresh round-trip, mirroring the local TTL window.
 *
 * SECURITY: never logs the API key or any value; grant ids are non-secret
 * routing handles. Approval happens off this host, closing the co-located
 * self-approval gap the local composition documents.
 */
export class OutrunManagement implements ManagementProvider {
  readonly name = "outrun";
  private pollIntervalMs: number;
  private timeoutMs: number;
  private grantCache = new Map<string, CachedGrant>();
  /**
   * In-flight approval requests keyed by secret name. A second get_secret for a
   * name whose approval is still pending awaits THIS promise instead of issuing a
   * duplicate `requestSecretAccess` — one human-facing grant per secret, even
   * when the model calls the tool twice (the duplicate-grant bug seen in prod).
   */
  private inFlight = new Map<string, Promise<AcquiredGrant>>();

  constructor(private client: OutrunClient, options: OutrunManagementOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  async requestAccess(req: AccessRequest): Promise<AccessGrant> {
    if (req.action === "write") {
      return { granted: false, denialReason: "writes are not supported in Outrun mode" };
    }

    const perSecret: NonNullable<AccessGrant["perSecret"]> = {};
    let allFromCache = true;

    for (const name of req.secretNames) {
      const cached = this.cachedGrant(name);
      if (cached) {
        perSecret[name] = { grantId: cached.grantId };
        continue;
      }
      allFromCache = false;

      try {
        const { grantId } = await this.grantFor(name, req);
        perSecret[name] = { grantId };
      } catch (err) {
        // First failure short-circuits the whole batch — the agent gets one
        // clean denial rather than a partial grant.
        if (err instanceof GrantNotApprovedError) {
          return { granted: false, denialReason: err.status };
        }
        throw err;
      }
    }

    return { granted: true, autoApproved: allFromCache, perSecret };
  }

  /**
   * Acquire an active grant for one secret, deduping concurrent requests: while a
   * request for this name is in flight, additional callers await the SAME promise
   * rather than opening a second approval. Throws `GrantNotApprovedError` on a
   * non-active terminal state (denied/revoked/expired/timeout).
   */
  private grantFor(name: string, req: AccessRequest): Promise<AcquiredGrant> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;

    const promise = this.acquireGrant(name, req);
    this.inFlight.set(name, promise);
    // Clear the slot once settled (either outcome) so a later access re-requests.
    // Guard against clobbering a newer entry for the same name. `then(cb, cb)`
    // rather than `finally` so this cleanup consumer also handles the rejection —
    // `finally`'s derived promise would surface a denial/timeout as an unhandled
    // rejection even though the real caller awaits and handles `promise` itself.
    const clear = () => {
      if (this.inFlight.get(name) === promise) this.inFlight.delete(name);
    };
    promise.then(clear, clear);
    return promise;
  }

  private async acquireGrant(name: string, req: AccessRequest): Promise<AcquiredGrant> {
    // req.vault disambiguates a lazily-referenced external item when 2+ vaults
    // are mounted (Outrun mints the reference row under that mount). Harmless
    // for outrun-stored names, which match before the lazy path runs.
    const { grantId, status } = await this.client.requestSecretAccess(name, req.reason, req.ttlMinutes, req.vault);
    const resolved = await this.awaitGrant(grantId, status);

    if (resolved.status !== "active") {
      throw new GrantNotApprovedError(resolved.status);
    }

    const exp = parseExpiry(resolved.expiresAt);
    if (exp !== null) this.grantCache.set(name, { grantId, expiresAt: exp });
    return { grantId, expiresAt: exp };
  }

  async logUse(use: UseLog): Promise<void> {
    if (!use.grantId) {
      throw new Error(`no active grant for "${use.secretName}"`);
    }
    const ok = await this.client.logSecretUse(use.grantId, use.reason);
    if (!ok) {
      // A false return (without a thrown error) still means "do not read".
      throw new Error("access was revoked");
    }
  }

  async listAvailable(): Promise<ManagedSecretMeta[]> {
    const items = await this.client.secrets();
    return items.map((s) => metaFromSecret(s));
  }

  /** Drop cached grants — after this every access re-requests approval. */
  async stop(): Promise<void> {
    this.grantCache.clear();
    this.inFlight.clear();
  }

  private cachedGrant(name: string): CachedGrant | null {
    const c = this.grantCache.get(name);
    if (!c) return null;
    if (c.expiresAt <= Date.now()) {
      this.grantCache.delete(name);
      return null;
    }
    return c;
  }

  /** Poll until the grant reaches a terminal state or the timeout elapses. */
  private async awaitGrant(
    grantId: string,
    initialStatus: string
  ): Promise<{ status: string; expiresAt?: string | null }> {
    let status = initialStatus;
    let expiresAt: string | null | undefined;
    const deadline = Date.now() + this.timeoutMs;

    while (!TERMINAL.has(status)) {
      if (Date.now() >= deadline) return { status: "timeout" };
      await sleep(this.pollIntervalMs);
      const g = await this.client.secretGrant(grantId);
      status = g.status;
      expiresAt = g.expiresAt;
    }

    // Server short-circuited to active on the initial request — fetch expiry
    // once so the grant can enter the reuse cache.
    if (status === "active" && expiresAt === undefined) {
      const g = await this.client.secretGrant(grantId);
      expiresAt = g.expiresAt;
    }
    return { status, expiresAt };
  }
}

function metaFromSecret(s: OutrunSecretMeta): ManagedSecretMeta {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    urls: s.urls,
    fields: s.fieldsMeta,
    storage: s.storage,
    status: s.status,
    group: s.storage === "outrun" ? "Outrun" : "External",
  };
}

/**
 * Outrun secret backend. Routing is PER-SECRET, driven by Outrun's item
 * metadata (not a config fork): a `storage: 'outrun'` item reads through the
 * OutrunSecretsProvider (`readSecretFields`, self-logging); a `storage: 'external'`
 * item reads from the local SecretProvider matching its mounted vault's provider
 * type, after `logUse`. One session can therefore serve both kinds at once, and
 * flipping a secret external→outrun in Outrun needs no SDK/config change.
 */
export class OutrunBackend implements SecretBackend {
  private outrunProvider: OutrunSecretsProvider;

  /**
   * @param client       Outrun GraphQL client.
   * @param management   the OutrunManagement hook (shared).
   * @param localProviders local SecretProviders (from the config `vaults`) used
   *                       to read mounted-external values in hybrid mode. Empty
   *                       in pure full-remote mode.
   * @param options      TTL default surfaced via ttlFor.
   */
  constructor(
    private client: OutrunClient,
    readonly management: OutrunManagement,
    private localProviders: SecretProvider[] = [],
    private options: OutrunManagementOptions = {}
  ) {
    this.outrunProvider = new OutrunSecretsProvider(client);
  }

  async list(): Promise<ListedGroup[]> {
    const [items, mounts] = await Promise.all([this.client.secrets(), this.client.secretVaultMounts()]);
    const groups: ListedGroup[] = [];

    const outrunItems = items.filter((s) => s.storage === "outrun");
    if (outrunItems.length) {
      groups.push({
        group: "Outrun",
        secrets: outrunItems.map((s) => ({ name: s.name, description: s.description })),
      });
    }

    const externalItems = items.filter((s) => s.storage === "external");
    if (externalItems.length) {
      groups.push({
        group: "External secrets",
        secrets: externalItems.map((s) => ({ name: s.name, description: s.description })),
      });
    }

    // Always surface the mounts themselves — a mounted vault's items appear
    // lazily (on first grant), so an agent may need to request an item by name
    // that isn't enumerated yet.
    for (const m of mounts) {
      groups.push({
        group: `${m.displayName} (mounted ${m.connectionData.provider} vault)`,
        secrets: [{ name: "*", note: "request items from this vault by name" }],
      });
    }

    return groups;
  }

  ttlFor(_vault: string | undefined): { ttlMinutes: number; ttlScope: "secret" | "vault" } {
    return { ttlMinutes: this.options.defaultTtlMinutes ?? 0, ttlScope: "secret" };
  }

  async resolveRead(_vault: string | undefined, name: string): Promise<ResolvedReadTarget> {
    const items = await this.client.secrets();
    const item = items.find((s) => s.name === name);

    if (item && item.storage === "outrun") {
      return { provider: this.outrunProvider, readId: item.id, logsUseInternally: true };
    }

    if (item && item.storage === "external") {
      const provider = await this.externalProviderFor(item);
      return { provider, readId: item.name, logsUseInternally: false };
    }

    // Not enumerated — may be a not-yet-surfaced item under a single mount.
    const mounts = await this.client.secretVaultMounts();
    if (mounts.length === 1) {
      const provider = this.localProviderByType(mounts[0].connectionData.provider);
      if (provider) return { provider, readId: name, logsUseInternally: false };
    }

    throw new Error(
      `Secret "${name}" not found in Outrun. Use list_secrets to see available items and mounted vaults.`
    );
  }

  resolveWrite(_vault: string | undefined, _name: string): ResolvedWriteTarget {
    throw new Error(
      "Writing secrets is not supported in Outrun mode. Create or rotate credentials in the Outrun UI."
    );
  }

  /** Pick the local provider that reads a mounted-external item's value. */
  private async externalProviderFor(item: OutrunSecretMeta): Promise<SecretProvider> {
    const mounts = await this.client.secretVaultMounts();
    // With a single mount the choice is unambiguous; with several we match the
    // first on provider type (item metadata does not carry its owning mount).
    const mount: OutrunMount | undefined = mounts[0];
    const provider = mount ? this.localProviderByType(mount.connectionData.provider) : undefined;
    if (!provider) {
      throw new Error(
        `No local secret provider configured to read external secret "${item.name}". ` +
          `Add the matching vault (e.g. 1password) to your config's "vaults" block.`
      );
    }
    return provider;
  }

  private localProviderByType(mountProvider: string): SecretProvider | undefined {
    const providerName = mountProvider === "env_file" ? "env-file" : mountProvider;
    return this.localProviders.find((p) => p.name === providerName);
  }
}
