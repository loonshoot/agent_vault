import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface VaultConfig {
  type: "env" | "1password";
  /** TTL in minutes for auto-approval after first approval (0 = always ask) */
  ttl: number;
  /**
   * What scope the TTL approval covers:
   * - "secret": each secret has its own approval window (default)
   * - "vault": approving any secret approves the entire vault for the TTL window
   */
  ttlScope?: "secret" | "vault";
  /** Whether agents can create/update secrets in this vault (default: false) */
  writable?: boolean;

  // env provider
  file?: string;

  // 1password provider
  serviceAccountToken?: string;
  vaultIds?: string[];
  /** Write config for 1password — which vault and category to create items in */
  write?: {
    /** The 1Password vault ID to create new items in */
    vaultId: string;
    /** Item category (default: "login") */
    category?: string;
  };
}

export interface WebhookConfig {
  /** Endpoint URL to POST events to */
  url: string;
  /** Optional authorization header value (supports env: references) */
  authorization?: string;
  /**
   * Which events to send: "all", or an array of specific event types.
   * "pending" fires the instant a request is created (before any human has acted) —
   * this is the only event type suitable for a "wake up and approve this" push
   * notification. "approved"/"denied"/"auto_approved" fire after resolution.
   */
  events?: "all" | ("pending" | "approved" | "denied" | "auto_approved")[];
  /**
   * Payload format. "json" (default) sends the standard structured event body.
   * "ntfy" sends a plain-text message plus ntfy.sh notification headers
   * (title/priority/click), so a plain `https://ntfy.sh/<topic>` endpoint renders
   * a readable push notification instead of a raw JSON blob.
   */
  format?: "json" | "ntfy";
}

/**
 * Outrun-managed mode. When present, approval / audit / revocation move to
 * Outrun (no ngrok approval server); per-secret routing decides whether a value
 * is served by Outrun (`readSecretFields`) or read from a local `vaults`
 * provider (hybrid, mounted external vault). `apiKey` supports env: indirection
 * like the rest of the config.
 */
export interface OutrunConfig {
  /** Gateway base URL — requests POST to `${url}/graphql`. */
  url: string;
  /** Gateway API key (workspace-scoped, `action:secrets` capability). Supports env: refs. */
  apiKey: string;
  /** Workspace the key is scoped to. */
  workspaceId: string;
  /** Poll interval (ms) while waiting for a standalone approval (default 3000). */
  pollIntervalMs?: number;
  /** Approval wait timeout (ms) before giving up (default 900000 = 15 min). */
  timeoutMs?: number;
  /** Default requested TTL (minutes) when the agent doesn't specify one. */
  defaultTtlMinutes?: number;
}

export interface AgentVaultConfigFile {
  vaults?: Record<string, VaultConfig>;
  outrun?: OutrunConfig;
  ngrokAuthToken?: string;
  port?: number;
  /** Webhook endpoints for observability — send access events to logging/analytics */
  webhooks?: WebhookConfig[];
  /**
   * MCP transport mode. "stdio" (default) spawns one server per client, matching
   * the classic `npx agent-vault` per-project usage. "http" runs a single
   * long-lived process reachable over the network by multiple remote clients,
   * sharing one pending-approval map, one TTL cache, and one audit log.
   * Can also be set via AGENT_VAULT_TRANSPORT or the --http CLI flag.
   */
  transport?: "stdio" | "http";
  /** Port for the HTTP MCP transport (default: 8080). Also AGENT_VAULT_HTTP_PORT / --port. */
  httpPort?: number;
  /** Host for the HTTP MCP transport (default: 127.0.0.1). Also AGENT_VAULT_HTTP_HOST / --host. */
  httpHost?: string;
}

/** Resolved config with env: references replaced by actual values */
export interface ResolvedConfig {
  vaults: Record<string, ResolvedVaultConfig>;
  outrun?: ResolvedOutrunConfig;
  ngrokAuthToken?: string;
  port: number;
  webhooks: ResolvedWebhookConfig[];
  transport: "stdio" | "http";
  httpPort: number;
  httpHost: string;
}

export interface ResolvedOutrunConfig {
  url: string;
  apiKey: string;
  workspaceId: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  defaultTtlMinutes?: number;
}

export interface ResolvedWebhookConfig {
  url: string;
  authorization?: string;
  events: "all" | ("pending" | "approved" | "denied" | "auto_approved")[];
  format: "json" | "ntfy";
}

export interface ResolvedVaultConfig {
  type: "env" | "1password";
  ttl: number;
  ttlScope: "secret" | "vault";
  writable: boolean;
  file?: string;
  serviceAccountToken?: string;
  vaultIds?: string[];
  write?: {
    vaultId: string;
    category: string;
  };
}

/**
 * Resolve "env:VAR_NAME" references to actual environment variable values.
 * Returns the resolved string, or undefined if the env var is not set.
 */
function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env:")) {
    const varName = value.slice(4);
    const envValue = process.env[varName];
    if (!envValue) {
      console.error(`Warning: environment variable "${varName}" is not set (referenced in config)`);
      return undefined;
    }
    return envValue;
  }
  return value;
}

/**
 * Load config from file. Searches for agent-vault.config.json in:
 * 1. Path specified by AGENT_VAULT_CONFIG env var
 * 2. Current working directory
 * 3. Home directory (~/.agent-vault.config.json)
 *
 * If no config file is found, exits with an error.
 */
export function loadConfig(): ResolvedConfig {
  const configPath = findConfigFile();

  if (!configPath) {
    console.error("Error: no config file found. Create agent-vault.config.json or set AGENT_VAULT_CONFIG env var.");
    process.exit(1);
  }

  console.error(`Loading config from ${configPath}`);
  return parseConfigFile(configPath);
}

function findConfigFile(): string | null {
  // Explicit path
  if (process.env.AGENT_VAULT_CONFIG) {
    const p = resolve(process.env.AGENT_VAULT_CONFIG);
    if (existsSync(p)) return p;
    console.error(`Warning: AGENT_VAULT_CONFIG points to ${p} but file not found`);
    return null;
  }

  // Current directory
  const cwd = resolve("agent-vault.config.json");
  if (existsSync(cwd)) return cwd;

  // Home directory
  const home = resolve(process.env.HOME || "~", ".agent-vault.config.json");
  if (existsSync(home)) return home;

  return null;
}

function parseConfigFile(configPath: string): ResolvedConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed: AgentVaultConfigFile = JSON.parse(raw);
  const configDir = dirname(configPath);

  const vaults: Record<string, ResolvedVaultConfig> = {};

  for (const [name, vault] of Object.entries(parsed.vaults ?? {})) {
    const resolved: ResolvedVaultConfig = {
      type: vault.type,
      ttl: vault.ttl ?? 0,
      ttlScope: vault.ttlScope ?? "secret",
      writable: vault.writable ?? false,
    };

    if (vault.type === "env") {
      // Resolve file path relative to config file location
      resolved.file = vault.file
        ? resolve(configDir, vault.file)
        : resolve(configDir, ".env.secrets");
    }

    if (vault.type === "1password") {
      resolved.serviceAccountToken = resolveEnvRef(vault.serviceAccountToken);
      resolved.vaultIds = vault.vaultIds;
      if (vault.write) {
        resolved.write = {
          vaultId: vault.write.vaultId,
          category: vault.write.category ?? "login",
        };
      }
    }

    vaults[name] = resolved;
  }

  const webhooks: ResolvedWebhookConfig[] = (parsed.webhooks ?? []).map((wh) => ({
    url: wh.url,
    authorization: resolveEnvRef(wh.authorization),
    events: wh.events ?? "all",
    format: wh.format ?? "json",
  }));

  // Transport resolution precedence: env var > config file > default.
  // (The --http / --port / --host CLI flags take precedence over all of this;
  // that's applied on top of the resolved config in index.ts.)
  const envTransport = process.env.AGENT_VAULT_TRANSPORT;
  const transport: "stdio" | "http" =
    envTransport === "http" || envTransport === "stdio"
      ? envTransport
      : parsed.transport ?? "stdio";

  const httpPort = process.env.AGENT_VAULT_HTTP_PORT
    ? Number(process.env.AGENT_VAULT_HTTP_PORT)
    : parsed.httpPort ?? 8080;

  const httpHost = process.env.AGENT_VAULT_HTTP_HOST || parsed.httpHost || "127.0.0.1";

  let outrun: ResolvedOutrunConfig | undefined;
  if (parsed.outrun) {
    const apiKey = resolveEnvRef(parsed.outrun.apiKey);
    if (!apiKey) {
      console.error(
        `Error: "outrun" block is configured but its apiKey could not be resolved (check the env var it references).`
      );
      process.exit(1);
    }
    outrun = {
      url: parsed.outrun.url,
      apiKey,
      workspaceId: parsed.outrun.workspaceId,
      pollIntervalMs: parsed.outrun.pollIntervalMs,
      timeoutMs: parsed.outrun.timeoutMs,
      defaultTtlMinutes: parsed.outrun.defaultTtlMinutes,
    };
  }

  return {
    vaults,
    outrun,
    ngrokAuthToken: resolveEnvRef(parsed.ngrokAuthToken),
    port: parsed.port ?? 9999,
    webhooks,
    transport,
    httpPort,
    httpHost,
  };
}

