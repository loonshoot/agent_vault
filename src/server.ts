import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SecretProvider } from "./providers/provider.js";
import type { ApprovalServer } from "./approval.js";
import type { AuditLog } from "./audit.js";
import type { WebhookDispatcher, AccessEvent } from "./webhooks.js";

export interface VaultInstance {
  name: string;
  provider: SecretProvider;
  ttlMinutes: number;
  ttlScope: "secret" | "vault";
  writable: boolean;
}

export interface AgentVaultConfig {
  vaults: VaultInstance[];
  approval: ApprovalServer;
  audit: AuditLog;
  webhooks: WebhookDispatcher;
}

export function createMcpServer(config: AgentVaultConfig): McpServer {
  const { vaults, approval, audit, webhooks } = config;

  const server = new McpServer({
    name: "agent-vault",
    version: "0.1.0",
  });

  // ── list_secrets ──────────────────────────────────────────────────

  server.tool(
    "list_secrets",
    "List available secret names across all configured vaults (never reveals values). Use this to discover what secrets are available before requesting them.",
    {},
    async () => {
      const sections: string[] = [];

      for (const vault of vaults) {
        const secrets = await vault.provider.listSecrets();
        if (secrets.length === 0) continue;

        const listing = secrets
          .map((s) => `  - ${s.name}${s.group ? ` (${s.group})` : ""}`)
          .join("\n");
        sections.push(`[${vault.name}]\n${listing}`);
      }

      return {
        content: [
          {
            type: "text",
            text: sections.length
              ? sections.join("\n\n")
              : "No secrets available in any vault.",
          },
        ],
      };
    }
  );

  // ── get_secret (single) ───────────────────────────────────────────

  server.tool(
    "get_secret",
    "Request access to a single secret. The user will be prompted to approve via a link. You MUST wait for the result. Prefer get_secrets when you need multiple secrets — it sends a single approval for all of them.",
    {
      vault: z.string().describe("The vault name containing the secret"),
      name: z.string().describe("The name/ID of the secret to access"),
      reason: z.string().describe("Why you need this secret — shown to the approver"),
    },
    async ({ vault: vaultName, name, reason }) => {
      const vault = findVault(vaults, vaultName);
      if (!vault) {
        return errorResponse(`Vault "${vaultName}" not found. Available: ${vaults.map((v) => v.name).join(", ")}`);
      }

      const auditKey = `${vaultName}/${name}`;

      // Check permission cache (secret-level or vault-level)
      if (audit.isPermitted(vaultName, auditKey)) {
        const value = await vault.provider.getSecret(name);
        audit.log(auditKey, reason, "auto_approved", "secret");
        webhooks.dispatch(accessEvent(vaultName, [name], reason, "auto_approved", "secret"));
        return {
          content: [{ type: "text" as const, text: `[Auto-approved — active approval window]\n\n${value}` }],
        };
      }

      // Request approval
      const { url, waitForApproval } = approval.requestApproval(
        `${vaultName} / ${name}`,
        reason
      );
      console.error(`\n🔒 Approve access to "${name}" from vault "${vaultName}": ${url}\n`);

      const approved = await waitForApproval;

      if (!approved) {
        audit.log(auditKey, reason, "denied", "secret");
        webhooks.dispatch(accessEvent(vaultName, [name], reason, "denied", "secret"));
        return errorResponse(`Access to "${name}" from vault "${vaultName}" was DENIED.`);
      }

      const value = await vault.provider.getSecret(name);
      const scope = vault.ttlScope;
      const logKey = scope === "vault" ? vaultName : auditKey;
      const ttl = vault.ttlMinutes || undefined;
      audit.log(logKey, reason, "approved", scope, ttl);
      webhooks.dispatch(accessEvent(vaultName, [name], reason, "approved", scope, ttl));

      return {
        content: [{ type: "text" as const, text: value }],
      };
    }
  );

  // ── get_secrets (batch) ───────────────────────────────────────────

  server.tool(
    "get_secrets",
    "Request access to multiple secrets at once. Sends a SINGLE approval request for all of them — much better UX than requesting one at a time. The user sees the full list of what you need and approves or denies all at once.",
    {
      vault: z.string().describe("The vault name containing the secrets"),
      names: z.array(z.string()).describe("List of secret names/IDs to access"),
      reason: z.string().describe("Why you need these secrets — shown to the approver"),
    },
    async ({ vault: vaultName, names, reason }) => {
      const vault = findVault(vaults, vaultName);
      if (!vault) {
        return errorResponse(`Vault "${vaultName}" not found. Available: ${vaults.map((v) => v.name).join(", ")}`);
      }

      // Split into already-permitted and needs-approval
      const permitted: string[] = [];
      const needsApproval: string[] = [];

      for (const name of names) {
        const auditKey = `${vaultName}/${name}`;
        if (audit.isPermitted(vaultName, auditKey)) {
          permitted.push(name);
        } else {
          needsApproval.push(name);
        }
      }

      // If everything is already permitted, fetch all
      if (needsApproval.length === 0) {
        const results = await fetchSecrets(vault, names, reason, audit, vaultName);
        webhooks.dispatch(accessEvent(vaultName, names, reason, "auto_approved", "secret"));
        return {
          content: [{ type: "text" as const, text: `[Auto-approved — active approval window]\n\n${formatResults(results)}` }],
        };
      }

      // Request approval for the batch
      const secretList = needsApproval.join(", ");
      const label = needsApproval.length === 1
        ? `${vaultName} / ${needsApproval[0]}`
        : `${vaultName} / ${needsApproval.length} secrets: ${secretList}`;

      const { url, waitForApproval } = approval.requestApproval(label, reason);
      console.error(`\n🔒 Approve access to [${secretList}] from vault "${vaultName}": ${url}\n`);

      const approved = await waitForApproval;

      if (!approved) {
        for (const name of needsApproval) {
          audit.log(`${vaultName}/${name}`, reason, "denied", "secret");
        }
        webhooks.dispatch(accessEvent(vaultName, needsApproval, reason, "denied", "secret"));
        return errorResponse(`Access to ${needsApproval.length} secret(s) from vault "${vaultName}" was DENIED.`);
      }

      // Log approval with appropriate scope
      const scope = vault.ttlScope;
      const ttl = vault.ttlMinutes || undefined;
      if (scope === "vault") {
        audit.log(vaultName, reason, "approved", "vault", ttl);
      } else {
        for (const name of needsApproval) {
          audit.log(`${vaultName}/${name}`, reason, "approved", "secret", ttl);
        }
      }
      webhooks.dispatch(accessEvent(vaultName, needsApproval, reason, "approved", scope, ttl));

      // Fetch all secrets (both previously permitted and newly approved)
      const results = await fetchSecrets(vault, names, reason, audit, vaultName);
      return {
        content: [{ type: "text" as const, text: formatResults(results) }],
      };
    }
  );

  // ── set_secret (single write) ────────────────────────────────────────

  server.tool(
    "set_secret",
    "Create or update a secret in a writable vault. The user will be prompted to approve via a link. Use this to persist credentials the agent has generated (API keys, tokens, etc.) so they don't get lost in chat history.",
    {
      vault: z.string().describe("The vault name to write to (must be writable)"),
      name: z.string().describe("The name/ID for the secret"),
      value: z.string().describe("The secret value to store"),
      reason: z.string().describe("Why you're creating/updating this secret — shown to the approver"),
    },
    async ({ vault: vaultName, name, value, reason }) => {
      const vault = findVault(vaults, vaultName);
      if (!vault) {
        return errorResponse(`Vault "${vaultName}" not found. Available: ${vaults.map((v) => v.name).join(", ")}`);
      }
      if (!vault.writable) {
        return errorResponse(`Vault "${vaultName}" is not writable. Set "writable": true in your config to enable writes.`);
      }
      if (!vault.provider.setSecret) {
        return errorResponse(`Provider "${vault.provider.name}" does not support writing secrets.`);
      }

      const masked = maskValue(value);
      const { url, waitForApproval } = approval.requestApproval(
        `${vaultName} / ${name}`,
        reason,
        { action: "write", maskedValue: masked }
      );
      console.error(`\n🔒 Approve WRITE of "${name}" to vault "${vaultName}": ${url}\n`);

      const approved = await waitForApproval;

      if (!approved) {
        audit.log(`${vaultName}/${name}`, reason, "denied", "secret");
        webhooks.dispatch(writeEvent(vaultName, [name], reason, "denied"));
        return errorResponse(`Write of "${name}" to vault "${vaultName}" was DENIED.`);
      }

      await vault.provider.setSecret(name, value);
      audit.log(`${vaultName}/${name}`, reason, "approved", "secret");
      webhooks.dispatch(writeEvent(vaultName, [name], reason, "approved"));

      return {
        content: [{ type: "text" as const, text: `Secret "${name}" saved to vault "${vaultName}".` }],
      };
    }
  );

  // ── set_secrets (batch write) ──────────────────────────────────────

  server.tool(
    "set_secrets",
    "Create or update multiple secrets at once with a single approval. Use this during bootstrapping when generating multiple credentials.",
    {
      vault: z.string().describe("The vault name to write to (must be writable)"),
      secrets: z.array(z.object({
        name: z.string().describe("The name/ID for the secret"),
        value: z.string().describe("The secret value to store"),
      })).describe("List of secrets to create/update"),
      reason: z.string().describe("Why you're creating/updating these secrets — shown to the approver"),
    },
    async ({ vault: vaultName, secrets, reason }) => {
      const vault = findVault(vaults, vaultName);
      if (!vault) {
        return errorResponse(`Vault "${vaultName}" not found. Available: ${vaults.map((v) => v.name).join(", ")}`);
      }
      if (!vault.writable) {
        return errorResponse(`Vault "${vaultName}" is not writable. Set "writable": true in your config to enable writes.`);
      }
      if (!vault.provider.setSecret) {
        return errorResponse(`Provider "${vault.provider.name}" does not support writing secrets.`);
      }

      const names = secrets.map((s) => s.name);
      const maskedPreviews = secrets.map((s) => `${s.name}: ${maskValue(s.value)}`).join("\n");
      const label = secrets.length === 1
        ? `${vaultName} / ${names[0]}`
        : `${vaultName} / ${secrets.length} secrets: ${names.join(", ")}`;

      const { url, waitForApproval } = approval.requestApproval(
        label,
        reason,
        { action: "write", maskedValue: maskedPreviews }
      );
      console.error(`\n🔒 Approve WRITE of [${names.join(", ")}] to vault "${vaultName}": ${url}\n`);

      const approved = await waitForApproval;

      if (!approved) {
        for (const name of names) {
          audit.log(`${vaultName}/${name}`, reason, "denied", "secret");
        }
        webhooks.dispatch(writeEvent(vaultName, names, reason, "denied"));
        return errorResponse(`Write of ${secrets.length} secret(s) to vault "${vaultName}" was DENIED.`);
      }

      for (const secret of secrets) {
        await vault.provider.setSecret!(secret.name, secret.value);
        audit.log(`${vaultName}/${secret.name}`, reason, "approved", "secret");
      }
      webhooks.dispatch(writeEvent(vaultName, names, reason, "approved"));

      return {
        content: [{ type: "text" as const, text: `${secrets.length} secret(s) saved to vault "${vaultName}": ${names.join(", ")}` }],
      };
    }
  );

  return server;
}

// ── Helpers ───────────────────────────────────────────────────────────

function findVault(vaults: VaultInstance[], name: string): VaultInstance | undefined {
  return vaults.find((v) => v.name === name);
}

function errorResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function fetchSecrets(
  vault: VaultInstance,
  names: string[],
  reason: string,
  audit: AuditLog,
  vaultName: string
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const name of names) {
    const value = await vault.provider.getSecret(name);
    results.set(name, value);
  }
  return results;
}

function formatResults(results: Map<string, string>): string {
  if (results.size === 1) {
    return results.values().next().value!;
  }
  return Array.from(results.entries())
    .map(([name, value]) => `[${name}]\n${value}`)
    .join("\n\n");
}

function accessEvent(
  vault: string,
  secrets: string[],
  reason: string,
  action: AccessEvent["action"],
  scope: AccessEvent["scope"],
  ttlMinutes?: number
): AccessEvent {
  return {
    timestamp: new Date().toISOString(),
    vault,
    secrets,
    reason,
    action,
    scope,
    ttlExpiresAt: ttlMinutes
      ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      : null,
  };
}

function writeEvent(
  vault: string,
  secrets: string[],
  reason: string,
  action: "approved" | "denied"
): AccessEvent {
  return {
    timestamp: new Date().toISOString(),
    vault,
    secrets,
    reason,
    action,
    scope: "secret",
    ttlExpiresAt: null,
  };
}

/** Mask a secret value for display: show first 3 and last 3 chars */
function maskValue(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}${"*".repeat(Math.min(value.length - 6, 20))}${value.slice(-3)}`;
}
