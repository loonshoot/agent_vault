import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SecretProvider } from "./providers/provider.js";
import type { ApprovalServer } from "./approval.js";
import type { AuditLog } from "./audit.js";
import type { WebhookDispatcher } from "./webhooks.js";
import type { RequesterAttribution, SecretBackend } from "./management/management.js";
import { LocalBackend, LocalManagement } from "./management/local-management.js";

export interface VaultInstance {
  name: string;
  provider: SecretProvider;
  ttlMinutes: number;
  ttlScope: "secret" | "vault";
  writable: boolean;
}

/**
 * Legacy construction shape — a set of local vaults plus the local approval
 * server, audit log, and webhook dispatcher. Still accepted verbatim (the
 * multi-worker test suite and `index.ts`'s local path both pass it), and turned
 * into a `LocalBackend` + `LocalManagement` internally so the tool handlers can
 * be mode-agnostic.
 */
export interface AgentVaultConfig {
  vaults: VaultInstance[];
  approval: ApprovalServer;
  audit: AuditLog;
  webhooks: WebhookDispatcher;
}

/** Backend-driven construction — used by the Outrun composition (and anything else). */
export interface BackendConfig {
  backend: SecretBackend;
}

function toBackend(config: AgentVaultConfig | BackendConfig): SecretBackend {
  if ("backend" in config) return config.backend;
  const management = new LocalManagement(config.approval, config.audit, config.webhooks);
  return new LocalBackend(config.vaults, management);
}

export function createMcpServer(config: AgentVaultConfig | BackendConfig): McpServer {
  const backend = toBackend(config);

  const server = new McpServer({
    name: "agent-vault",
    version: "0.1.0",
  });

  // ── list_secrets ──────────────────────────────────────────────────

  server.tool(
    "list_secrets",
    "List available secret names (never reveals values). Use this to discover what secrets are available before requesting them.",
    {},
    async () => {
      const groups = await backend.list();
      const sections: string[] = [];
      for (const g of groups) {
        if (g.secrets.length === 0) continue;
        const listing = g.secrets
          .map((s) => {
            const note = s.note ? ` (${s.note})` : "";
            const desc = s.description ? `\n      ${s.description}` : "";
            return `  - ${s.name}${note}${desc}`;
          })
          .join("\n");
        sections.push(`[${g.group}]\n${listing}`);
      }
      return {
        content: [
          {
            type: "text",
            text: sections.length ? sections.join("\n\n") : "No secrets available in any vault.",
          },
        ],
      };
    }
  );

  // ── get_secret (single) ───────────────────────────────────────────

  server.tool(
    "get_secret",
    "Request access to a single secret. This opens a human approval request (an Outrun HITL prompt, or an approval link in local mode) and BLOCKS until the human approves or denies — this can take minutes. Call this tool ONCE per secret and WAIT for it to return: do NOT call it again, retry, or poll yourself. The single call handles all the waiting and returns the secret value on approval, or an error on denial/timeout. Prefer get_secrets when you need multiple secrets — it sends a single approval for all of them.",
    {
      vault: z.string().optional().describe("The vault name containing the secret (required in local mode; ignored in Outrun mode, where secrets are addressed by name)"),
      name: z.string().describe("The name/ID of the secret to access"),
      reason: z.string().describe("Why you need this secret — shown to the approver and recorded as the access purpose"),
      requesterId: z.string().optional().describe("Identity of the requesting worker/agent (optional, shown to the approver for attribution)"),
      taskId: z.string().optional().describe("Task or job identifier this request is on behalf of (optional)"),
      branch: z.string().optional().describe("Branch or workspace identifier (optional)"),
    },
    async ({ vault, name, reason, requesterId, taskId, branch }) => {
      return readSecrets(backend, vault, [name], reason, { requesterId, taskId, branch }, true);
    }
  );

  // ── get_secrets (batch) ───────────────────────────────────────────

  server.tool(
    "get_secrets",
    "Request access to multiple secrets at once. Sends a SINGLE approval request for all of them — much better UX than requesting one at a time. The user sees the full list of what you need and approves or denies all at once. This opens a human approval request and BLOCKS until the human approves or denies — this can take minutes. Call this tool ONCE and WAIT for it to return: do NOT call it again, retry, or poll yourself. The single call handles all the waiting and returns the secret values on approval, or an error on denial/timeout.",
    {
      vault: z.string().optional().describe("The vault name containing the secrets (required in local mode; ignored in Outrun mode)"),
      names: z.array(z.string()).describe("List of secret names/IDs to access"),
      reason: z.string().describe("Why you need these secrets — shown to the approver and recorded as the access purpose"),
      requesterId: z.string().optional().describe("Identity of the requesting worker/agent (optional, shown to the approver for attribution)"),
      taskId: z.string().optional().describe("Task or job identifier this request is on behalf of (optional)"),
      branch: z.string().optional().describe("Branch or workspace identifier (optional)"),
    },
    async ({ vault, names, reason, requesterId, taskId, branch }) => {
      return readSecrets(backend, vault, names, reason, { requesterId, taskId, branch }, false);
    }
  );

  // ── set_secret (single write) ────────────────────────────────────────

  server.tool(
    "set_secret",
    "Create or update a secret in a writable vault. The user will be prompted to approve via a link. Use this to persist credentials the agent has generated (API keys, tokens, etc.) so they don't get lost in chat history.",
    {
      vault: z.string().optional().describe("The vault name to write to (must be writable)"),
      name: z.string().describe("The name/ID for the secret"),
      value: z.string().describe("The secret value to store"),
      reason: z.string().describe("Why you're creating/updating this secret — shown to the approver"),
      requesterId: z.string().optional().describe("Identity of the requesting worker/agent (optional, shown to the approver for attribution)"),
      taskId: z.string().optional().describe("Task or job identifier this request is on behalf of (optional)"),
      branch: z.string().optional().describe("Branch or workspace identifier (optional)"),
    },
    async ({ vault, name, value, reason, requesterId, taskId, branch }) => {
      return writeSecrets(backend, vault, [{ name, value }], reason, { requesterId, taskId, branch });
    }
  );

  // ── set_secrets (batch write) ──────────────────────────────────────

  server.tool(
    "set_secrets",
    "Create or update multiple secrets at once with a single approval. Use this during bootstrapping when generating multiple credentials.",
    {
      vault: z.string().optional().describe("The vault name to write to (must be writable)"),
      secrets: z.array(z.object({
        name: z.string().describe("The name/ID for the secret"),
        value: z.string().describe("The secret value to store"),
      })).describe("List of secrets to create/update"),
      reason: z.string().describe("Why you're creating/updating these secrets — shown to the approver"),
      requesterId: z.string().optional().describe("Identity of the requesting worker/agent (optional, shown to the approver for attribution)"),
      taskId: z.string().optional().describe("Task or job identifier this request is on behalf of (optional)"),
      branch: z.string().optional().describe("Branch or workspace identifier (optional)"),
    },
    async ({ vault, secrets, reason, requesterId, taskId, branch }) => {
      return writeSecrets(backend, vault, secrets, reason, { requesterId, taskId, branch });
    }
  );

  return server;
}

// ── Read/write orchestration (mode-agnostic) ────────────────────────────
//
// Both paths follow the same shape for every backend:
//   1. resolveRead/resolveWrite up front — fail fast on an unknown vault/secret
//      BEFORE any approval is opened (matches the legacy findVault-before-approval
//      order, so a typo never pings a human).
//   2. management.requestAccess — the single BLOCKING approval for the batch.
//      Local waits on the ngrok page; Outrun runs request→poll. Audit + webhook
//      side effects of the DECISION live inside the management hook.
//   3. per-secret read — for a target that does not log its own use
//      (local vault, mounted-external), call management.logUse BEFORE reading so a
//      server-side revocation refuses the read; for an Outrun-stored target the
//      value read (readSecretFields) is itself the logged use.

async function readSecrets(
  backend: SecretBackend,
  vault: string | undefined,
  names: string[],
  reason: string,
  requester: RequesterAttribution,
  single: boolean
) {
  // Resolve every target first so a bad name is reported without an approval.
  const targets = [];
  for (const name of names) {
    try {
      targets.push(await backend.resolveRead(vault, name));
    } catch (err: any) {
      return errorResponse(err.message);
    }
  }

  const { ttlMinutes, ttlScope } = backend.ttlFor(vault);
  const grant = await backend.management.requestAccess({
    vault,
    secretNames: names,
    reason,
    ttlMinutes,
    ttlScope,
    action: "read",
    requester,
  });

  if (!grant.granted) {
    const why = grant.denialReason && grant.denialReason !== "denied" ? ` (${grant.denialReason})` : "";
    return errorResponse(
      single
        ? `Access to "${names[0]}"${vaultSuffix(vault)} was DENIED${why}.`
        : `Access to ${names.length} secret(s)${vaultSuffix(vault)} was DENIED${why}.`
    );
  }

  const results = new Map<string, string>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const target = targets[i];
    const grantId = grant.perSecret?.[name]?.grantId;

    if (!target.logsUseInternally) {
      try {
        await backend.management.logUse({ grantId, vault, secretName: name, reason, requester });
      } catch (err: any) {
        // Revoked/denied server-side between grant and read — refuse, do not read locally.
        return errorResponse(`Access to "${name}" was refused: ${err.message}`);
      }
    }

    try {
      const value = await target.provider.getSecret(target.readId, { purpose: reason, grantId });
      results.set(name, value);
    } catch (err: any) {
      return errorResponse(`Failed to read "${name}": ${err.message}`);
    }
  }

  const prefix = grant.autoApproved ? "[Auto-approved — active approval window]\n\n" : "";
  return { content: [{ type: "text" as const, text: prefix + formatResults(results) }] };
}

async function writeSecrets(
  backend: SecretBackend,
  vault: string | undefined,
  secrets: { name: string; value: string }[],
  reason: string,
  requester: RequesterAttribution
) {
  const targets = [];
  for (const s of secrets) {
    try {
      targets.push(backend.resolveWrite(vault, s.name));
    } catch (err: any) {
      return errorResponse(err.message);
    }
  }

  const names = secrets.map((s) => s.name);
  const maskedValue =
    secrets.length === 1
      ? maskValue(secrets[0].value)
      : secrets.map((s) => `${s.name}: ${maskValue(s.value)}`).join("\n");

  const grant = await backend.management.requestAccess({
    vault,
    secretNames: names,
    reason,
    action: "write",
    maskedValue,
    requester,
  });

  if (!grant.granted) {
    return errorResponse(`Write of ${secrets.length} secret(s)${vaultSuffix(vault)} was DENIED.`);
  }

  const saved: string[] = [];
  for (let i = 0; i < secrets.length; i++) {
    try {
      await targets[i].provider.setSecret!(targets[i].writeId, secrets[i].value);
      saved.push(secrets[i].name);
    } catch (err: any) {
      return errorResponse(
        `Failed to write "${secrets[i].name}"${vaultSuffix(vault)}: ${err.message}` +
          (saved.length ? ` (${saved.length} secret(s) saved before failure: ${saved.join(", ")})` : "")
      );
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text:
          secrets.length === 1
            ? `Secret "${names[0]}"${vaultSuffix(vault)} saved.`
            : `${secrets.length} secret(s) saved${vaultSuffix(vault)}: ${names.join(", ")}`,
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function vaultSuffix(vault: string | undefined): string {
  return vault ? ` from vault "${vault}"` : "";
}

function errorResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatResults(results: Map<string, string>): string {
  if (results.size === 1) {
    return results.values().next().value!;
  }
  return Array.from(results.entries())
    .map(([name, value]) => `[${name}]\n${value}`)
    .join("\n\n");
}

/** Mask a secret value for display: show first 3 and last 3 chars */
function maskValue(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}${"*".repeat(Math.min(value.length - 6, 20))}${value.slice(-3)}`;
}
