#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalServer } from "./approval.js";
import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { createMcpServer, type VaultInstance } from "./server.js";
import { WebhookDispatcher } from "./webhooks.js";
import { startHttpTransport } from "./http-transport.js";
import { EnvFileProvider } from "./providers/env-provider.js";
import { OnePasswordProvider } from "./providers/onepassword-provider.js";
import type { ResolvedVaultConfig } from "./config.js";
import { parseCliArgs } from "./cli-args.js";

async function main() {
  const config = loadConfig();
  const cli = parseCliArgs(process.argv.slice(2));

  const useHttp = cli.http ?? config.transport === "http";
  const httpPort = cli.port ?? config.httpPort;
  const httpHost = cli.host ?? config.httpHost;

  const dbPath = process.env.AGENT_VAULT_DB || "agent-vault.db";
  const audit = new AuditLog(dbPath);
  const webhooks = new WebhookDispatcher(config.webhooks);
  // ApprovalServer holds the single shared `pending` map for this process —
  // in HTTP mode every remote client shares this one instance (and therefore
  // one pending map, one audit log, one webhook dispatcher) instead of each
  // getting its own fragmented stdio subprocess's state.
  const approval = new ApprovalServer(config.port, webhooks);

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

  // Shared across every request/session: `vaults`, `approval` (and its
  // `pending` map), `audit` (TTL cache + log), and `webhooks`. In HTTP mode a
  // fresh McpServer wrapper is created per request (required by the SDK's
  // stateless transport — see http-transport.ts), but it's just protocol
  // glue around this same shared config — no state is fragmented.
  const buildMcpServer = () => createMcpServer({ vaults, approval, audit, webhooks });

  let httpServer: import("node:http").Server | undefined;
  if (useHttp) {
    console.error(`Starting MCP HTTP transport on ${httpHost}:${httpPort}...`);
    httpServer = await startHttpTransport(buildMcpServer, { port: httpPort, host: httpHost });
  } else {
    const mcpServer = buildMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  }

  // Cleanup on exit
  const cleanup = async () => {
    console.error("Shutting down...");
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
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
      return new OnePasswordProvider(config.serviceAccountToken, config.vaultIds || [], config.write);
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
