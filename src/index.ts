#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ApprovalServer } from "./approval.js";
import type { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { createMcpServer, type VaultInstance } from "./server.js";
import { startHttpTransport } from "./http-transport.js";
import { EnvFileProvider } from "./providers/env-provider.js";
import { OnePasswordProvider } from "./providers/onepassword-provider.js";
import type { ResolvedVaultConfig } from "./config.js";
import { parseCliArgs } from "./cli-args.js";
import { OutrunClient } from "./outrun/client.js";
import { OutrunManagement, OutrunBackend } from "./management/outrun-management.js";
import { LocalManagement, LocalBackend } from "./management/local-management.js";
import type { SecretBackend } from "./management/management.js";
import { runFetchCli } from "./fetch-cli.js";

async function main() {
  // `agent-vault fetch --secret X --reason Y` is a one-shot headless mode,
  // not the MCP server — handle it before touching any MCP transport/server
  // setup and exit directly with its result. See fetch-cli.ts for why this
  // exists (bootstrapping an agent's OWN launch credential from the vault).
  if (process.argv[2] === "fetch") {
    const code = await runFetchCli(process.argv.slice(3));
    process.exit(code);
  }

  const config = loadConfig();
  const cli = parseCliArgs(process.argv.slice(2));

  const useHttp = cli.http ?? config.transport === "http";
  const httpPort = cli.port ?? config.httpPort;
  const httpHost = cli.host ?? config.httpHost;

  const dbPath = process.env.AGENT_VAULT_DB || "agent-vault.db";

  // Build vault instances from config. In local mode these ARE the vaults; in
  // Outrun mode they are the local SecretProviders that read mounted-external
  // (hybrid) values — Outrun-stored values never touch them.
  const vaults: VaultInstance[] = [];
  for (const [name, vaultConfig] of Object.entries(config.vaults)) {
    const provider = createProvider(name, vaultConfig);
    vaults.push({ name, provider, ttlMinutes: vaultConfig.ttl, ttlScope: vaultConfig.ttlScope, writable: vaultConfig.writable });
    console.error(`  Vault "${name}" → ${vaultConfig.type} (TTL: ${vaultConfig.ttl}m, scope: ${vaultConfig.ttlScope}${vaultConfig.writable ? ", writable" : ""})`);
  }

  let backend: SecretBackend;
  let approval: ApprovalServer | undefined;
  let audit: AuditLog | undefined;

  if (config.outrun) {
    // ── Outrun-managed mode: approval/audit/revocation live in Outrun. ──
    // No approval server, no ngrok. Local providers (if any) serve hybrid
    // mounted-external reads; a pure full-remote setup needs no vaults at all.
    console.error(`Outrun-managed mode → ${config.outrun.url} (workspace ${config.outrun.workspaceId})`);
    const client = new OutrunClient({
      url: config.outrun.url,
      apiKey: config.outrun.apiKey,
      workspaceId: config.outrun.workspaceId,
    });
    const management = new OutrunManagement(client, {
      pollIntervalMs: config.outrun.pollIntervalMs,
      timeoutMs: config.outrun.timeoutMs,
      defaultTtlMinutes: config.outrun.defaultTtlMinutes,
    });
    backend = new OutrunBackend(
      client,
      management,
      vaults.map((v) => v.provider),
      { defaultTtlMinutes: config.outrun.defaultTtlMinutes }
    );
  } else {
    // ── Local mode: the original PoC composition. ──
    // Dynamic imports, not static top-of-file ones: better-sqlite3 (audit.js)
    // needs a native build, and Outrun-mode-only deployments (e.g. the
    // outrun-ai-developer worker container, which only ever uses Outrun mode
    // and `agent-vault fetch`) shouldn't need a C/C++ toolchain just because
    // this module happened to be imported — a static `import` is resolved at
    // module-load time regardless of which branch runs, so it was pulling in
    // better-sqlite3 even for `agent-vault fetch`'s early-exit path above.
    if (vaults.length === 0) {
      console.error("Error: no vaults configured (and no `outrun` block).");
      process.exit(1);
    }
    const { AuditLog } = await import("./audit.js");
    const { ApprovalServer } = await import("./approval.js");
    const { WebhookDispatcher } = await import("./webhooks.js");
    audit = new AuditLog(dbPath);
    const webhooks = new WebhookDispatcher(config.webhooks);
    // ApprovalServer holds the single shared `pending` map for this process —
    // in HTTP mode every remote client shares this one instance (and therefore
    // one pending map, one audit log, one webhook dispatcher) instead of each
    // getting its own fragmented stdio subprocess's state.
    approval = new ApprovalServer(config.port, webhooks);

    console.error("Starting approval server...");
    const publicUrl = await approval.start(config.ngrokAuthToken);
    console.error(`Approval server ready: ${publicUrl}`);

    backend = new LocalBackend(vaults, new LocalManagement(approval, audit, webhooks));
  }

  // In HTTP mode a fresh McpServer wrapper is created per request (required by
  // the SDK's stateless transport — see http-transport.ts), but it wraps this
  // same shared backend, so no approval/audit/grant-cache state is fragmented.
  const buildMcpServer = () => createMcpServer({ backend });

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
    await backend.management.stop?.();
    if (approval) await approval.stop();
    if (audit) audit.close();
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
