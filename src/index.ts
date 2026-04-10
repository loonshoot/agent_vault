#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApprovalServer } from "./approval.js";
import { AuditLog } from "./audit.js";
import { createMcpServer } from "./server.js";
import { EnvFileProvider } from "./providers/env-provider.js";
import { OnePasswordProvider } from "./providers/onepassword-provider.js";
import type { SecretProvider } from "./providers/provider.js";

async function main() {
  const provider = resolveProvider();
  const port = parseInt(process.env.AGENT_VAULT_PORT || "9999", 10);
  const ttlMinutes = parseInt(process.env.AGENT_VAULT_TTL_MINUTES || "0", 10);
  const dbPath = process.env.AGENT_VAULT_DB || "agent-vault.db";

  const approval = new ApprovalServer(port);
  const audit = new AuditLog(dbPath);

  // Start ngrok tunnel
  console.error("Starting approval server...");
  const publicUrl = await approval.start();
  console.error(`Approval server ready: ${publicUrl}`);

  const mcpServer = createMcpServer({ provider, approval, audit, ttlMinutes });
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

function resolveProvider(): SecretProvider {
  const providerType = process.env.AGENT_VAULT_PROVIDER || "env";

  switch (providerType) {
    case "env": {
      const path = process.env.AGENT_VAULT_ENV_FILE || ".env.secrets";
      console.error(`Using env-file provider: ${path}`);
      return new EnvFileProvider(path);
    }
    case "1password": {
      if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
        console.error("Error: OP_SERVICE_ACCOUNT_TOKEN is required for 1password provider");
        process.exit(1);
      }
      const vaultIds = process.env.AGENT_VAULT_1P_VAULTS?.split(",").filter(Boolean) || [];
      console.error(`Using 1password provider${vaultIds.length ? `: vaults ${vaultIds.join(", ")}` : ""}`);
      return new OnePasswordProvider(vaultIds);
    }
    default:
      console.error(`Unknown provider: ${providerType}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
