#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalServer } from "./approval.js";
import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { createMcpServer, type VaultInstance } from "./server.js";
import { WebhookDispatcher } from "./webhooks.js";
import { EnvFileProvider } from "./providers/env-provider.js";
import { OnePasswordProvider } from "./providers/onepassword-provider.js";
import type { ResolvedVaultConfig } from "./config.js";

async function main() {
  const config = loadConfig();

  const approval = new ApprovalServer(config.port);
  const dbPath = process.env.AGENT_VAULT_DB || "agent-vault.db";
  const audit = new AuditLog(dbPath);

  // Build vault instances from config
  const vaults: VaultInstance[] = [];
  for (const [name, vaultConfig] of Object.entries(config.vaults)) {
    const provider = createProvider(name, vaultConfig);
    vaults.push({ name, provider, ttlMinutes: vaultConfig.ttl, ttlScope: vaultConfig.ttlScope, writable: vaultConfig.writable });
    console.error(`  Vault "${name}" → ${vaultConfig.type} (TTL: ${vaultConfig.ttl}m, scope: ${vaultConfig.ttlScope}${vaultConfig.writable ? ", writable" : ""})`);
  }

  if (vaults.length === 0) {
    console.error("Error: no vaults configured");
    process.exit(1);
  }

  // Start approval server
  console.error("Starting approval server...");
  const publicUrl = await approval.start(config.ngrokAuthToken);
  console.error(`Approval server ready: ${publicUrl}`);

  const webhooks = new WebhookDispatcher(config.webhooks);
  const mcpServer = createMcpServer({ vaults, approval, audit, webhooks });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  // Cleanup on exit
  const cleanup = async () => {
    console.error("Shutting down...");
    await approval.stop();
    audit.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function createProvider(name: string, config: ResolvedVaultConfig) {
  switch (config.type) {
    case "env": {
      const path = config.file || ".env.secrets";
      return new EnvFileProvider(path);
    }
    case "1password": {
      if (!config.serviceAccountToken) {
        console.error(`Error: vault "${name}" is type 1password but service account token is not set`);
        process.exit(1);
      }
      // Set the token for the 1Password SDK (it reads from env)
      process.env.OP_SERVICE_ACCOUNT_TOKEN = config.serviceAccountToken;
      return new OnePasswordProvider(config.vaultIds || [], config.write);
    }
    default:
      console.error(`Unknown provider type "${config.type}" for vault "${name}"`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
