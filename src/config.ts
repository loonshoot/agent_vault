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

  // env provider
  file?: string;

  // 1password provider
  serviceAccountToken?: string;
  vaultIds?: string[];
}

export interface WebhookConfig {
  /** Endpoint URL to POST events to */
  url: string;
  /** Optional authorization header value (supports env: references) */
  authorization?: string;
  /** Which events to send: "all", "approved", "denied", or an array of specific actions */
  events?: "all" | ("approved" | "denied" | "auto_approved")[];
}

export interface AgentVaultConfigFile {
  vaults: Record<string, VaultConfig>;
  ngrokAuthToken?: string;
  port?: number;
  /** Webhook endpoints for observability — send access events to logging/analytics */
  webhooks?: WebhookConfig[];
}

/** Resolved config with env: references replaced by actual values */
export interface ResolvedConfig {
  vaults: Record<string, ResolvedVaultConfig>;
  ngrokAuthToken?: string;
  port: number;
  webhooks: ResolvedWebhookConfig[];
}

export interface ResolvedWebhookConfig {
  url: string;
  authorization?: string;
  events: "all" | ("approved" | "denied" | "auto_approved")[];
}

export interface ResolvedVaultConfig {
  type: "env" | "1password";
  ttl: number;
  ttlScope: "secret" | "vault";
  file?: string;
  serviceAccountToken?: string;
  vaultIds?: string[];
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
 * If no config file is found, falls back to legacy env var configuration
 * with a single vault.
 */
export function loadConfig(): ResolvedConfig {
  const configPath = findConfigFile();

  if (configPath) {
    console.error(`Loading config from ${configPath}`);
    return parseConfigFile(configPath);
  }

  // Legacy fallback: build config from env vars (single vault)
  console.error("No config file found — using environment variables (legacy mode)");
  return buildLegacyConfig();
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

  for (const [name, vault] of Object.entries(parsed.vaults)) {
    const resolved: ResolvedVaultConfig = {
      type: vault.type,
      ttl: vault.ttl ?? 0,
      ttlScope: vault.ttlScope ?? "secret",
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
    }

    vaults[name] = resolved;
  }

  const webhooks: ResolvedWebhookConfig[] = (parsed.webhooks ?? []).map((wh) => ({
    url: wh.url,
    authorization: resolveEnvRef(wh.authorization),
    events: wh.events ?? "all",
  }));

  return {
    vaults,
    ngrokAuthToken: resolveEnvRef(parsed.ngrokAuthToken),
    port: parsed.port ?? 9999,
    webhooks,
  };
}

function buildLegacyConfig(): ResolvedConfig {
  const providerType = process.env.AGENT_VAULT_PROVIDER || "env";
  const ttl = parseInt(process.env.AGENT_VAULT_TTL_MINUTES || "0", 10);

  const vaults: Record<string, ResolvedVaultConfig> = {};

  if (providerType === "1password") {
    vaults["default"] = {
      type: "1password",
      ttl,
      ttlScope: "secret",
      serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      vaultIds: process.env.AGENT_VAULT_1P_VAULTS?.split(",").filter(Boolean),
    };
  } else {
    vaults["default"] = {
      type: "env",
      ttl,
      ttlScope: "secret",
      file: resolve(process.env.AGENT_VAULT_ENV_FILE || ".env.secrets"),
    };
  }

  return {
    vaults,
    ngrokAuthToken: process.env.NGROK_AUTHTOKEN,
    port: parseInt(process.env.AGENT_VAULT_PORT || "9999", 10),
    webhooks: [],
  };
}
