import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SecretProvider } from "./providers/provider.js";
import type { ApprovalServer } from "./approval.js";
import type { AuditLog } from "./audit.js";

export interface AgentVaultConfig {
  provider: SecretProvider;
  approval: ApprovalServer;
  audit: AuditLog;
  /** Minutes to auto-approve after first approval (default: 0 = always ask) */
  ttlMinutes: number;
}

export function createMcpServer(config: AgentVaultConfig): McpServer {
  const { provider, approval, audit, ttlMinutes } = config;

  const server = new McpServer({
    name: "agent-vault",
    version: "0.1.0",
  });

  server.tool(
    "list_secrets",
    "List available secret names (never reveals values). Use this to discover what secrets are available before requesting one.",
    {},
    async () => {
      const secrets = await provider.listSecrets();
      const listing = secrets.map((s) => `- ${s.name}${s.group ? ` (${s.group})` : ""}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: secrets.length
              ? `Available secrets:\n${listing}`
              : "No secrets available.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_secret",
    "Request access to a secret. The user will be prompted to approve via a link. You MUST wait for the result — do not proceed without the secret value or a denial.",
    {
      name: z.string().describe("The name/ID of the secret to access"),
      reason: z.string().describe("Why you need this secret — shown to the approver"),
    },
    async ({ name, reason }) => {
      // Check for active TTL approval
      if (audit.hasActiveApproval(name)) {
        const value = await provider.getSecret(name);
        audit.log(name, reason, "auto_approved");
        return {
          content: [
            {
              type: "text",
              text: `[Auto-approved — active approval window]\n\n${value}`,
            },
          ],
        };
      }

      // Request approval via link
      const { url, waitForApproval } = approval.requestApproval(name, reason);

      // Send the link as a progress notification by returning a two-phase response:
      // First, log that we're waiting
      const approved = await new Promise<boolean>(async (resolve) => {
        // Log the URL for the agent to display
        console.error(`\n🔒 Approve access to "${name}": ${url}\n`);

        const result = await waitForApproval;
        resolve(result);
      });

      if (!approved) {
        audit.log(name, reason, "denied");
        return {
          content: [
            {
              type: "text",
              text: `Access to "${name}" was DENIED by the user.`,
            },
          ],
        };
      }

      // Approved — fetch and return the secret
      const value = await provider.getSecret(name);
      audit.log(name, reason, "approved", ttlMinutes || undefined);
      return {
        content: [
          {
            type: "text",
            text: value,
          },
        ],
      };
    }
  );

  return server;
}
