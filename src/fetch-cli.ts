import { loadConfig } from "./config.js";
import { OutrunClient } from "./outrun/client.js";
import { OutrunManagement, OutrunBackend } from "./management/outrun-management.js";

export interface FetchCliArgs {
  secret?: string;
  reason?: string;
  vault?: string;
  requesterId?: string;
  taskId?: string;
  branch?: string;
}

/**
 * Parses `agent-vault fetch` flags. Separate from cli-args.ts's parseCliArgs
 * (which only handles the MCP-server `--http`/`--port`/`--host` flags) —
 * `fetch` is a distinct one-shot mode, not a transport option.
 */
export function parseFetchArgs(argv: string[]): FetchCliArgs {
  const args: FetchCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--secret") args.secret = argv[++i];
    else if (arg === "--reason") args.reason = argv[++i];
    else if (arg === "--vault") args.vault = argv[++i];
    else if (arg === "--requester-id") args.requesterId = argv[++i];
    else if (arg === "--task-id") args.taskId = argv[++i];
    else if (arg === "--branch") args.branch = argv[++i];
  }
  return args;
}

/**
 * `agent-vault fetch --secret <name> --reason <text>` — a headless, one-shot
 * request→poll-for-approval→read, reusing the SAME OutrunManagement/OutrunBackend
 * the MCP `get_secret` tool drives (server.ts), but callable BEFORE any MCP
 * client (e.g. Claude Code) exists. This is the piece that lets an entrypoint
 * script bootstrap ITS OWN launch credential (e.g. CLAUDE_CODE_OAUTH_TOKEN) from
 * the vault, closing the chicken-and-egg gap: an MCP server can't serve the
 * secret an agent needs to start talking to the MCP server's own host agent.
 *
 * Outrun-mode only — local mode's approval page assumes a human at a browser
 * (or an ngrok link to tap), which doesn't fit a one-shot non-interactive CLI
 * call the same way. Local support can be added later if a use case needs it.
 *
 * On success: the raw secret value is the ONLY thing written to stdout, so
 * callers can safely do `TOKEN=$(agent-vault fetch --secret X --reason Y)`.
 * Everything else (config-loading notices, poll status, errors) goes to
 * stderr, matching the rest of this codebase's console.error convention.
 *
 * @returns process exit code (0 success, 1 failure)
 */
export async function runFetchCli(argv: string[]): Promise<number> {
  const args = parseFetchArgs(argv);

  if (!args.secret) {
    console.error("Error: agent-vault fetch requires --secret <name>");
    return 1;
  }
  if (!args.reason || !args.reason.trim()) {
    console.error("Error: agent-vault fetch requires --reason <text> (shown to the approver and audited)");
    return 1;
  }

  const config = loadConfig();
  if (!config.outrun) {
    console.error(
      "Error: agent-vault fetch requires an \"outrun\" block in agent-vault.config.json " +
      "(local-vault mode is not supported for headless fetch)."
    );
    return 1;
  }

  console.error(`Fetching secret "${args.secret}" from Outrun (workspace ${config.outrun.workspaceId})...`);

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
  const backend = new OutrunBackend(client, management, [], {
    defaultTtlMinutes: config.outrun.defaultTtlMinutes,
  });

  const requester = (args.requesterId || args.taskId || args.branch)
    ? { requesterId: args.requesterId, taskId: args.taskId, branch: args.branch }
    : undefined;

  let target;
  try {
    target = await backend.resolveRead(args.vault, args.secret);
  } catch (err: any) {
    console.error(`Error: ${err?.message ?? err}`);
    return 1;
  }

  const { ttlMinutes, ttlScope } = backend.ttlFor(args.vault);
  const grant = await backend.management.requestAccess({
    vault: args.vault,
    secretNames: [args.secret],
    reason: args.reason,
    ttlMinutes,
    ttlScope,
    action: "read",
    requester,
  });

  if (!grant.granted) {
    const why = grant.denialReason && grant.denialReason !== "denied" ? ` (${grant.denialReason})` : "";
    console.error(`Access to "${args.secret}" was DENIED${why}.`);
    return 1;
  }

  const grantId = grant.perSecret?.[args.secret]?.grantId;

  if (!target.logsUseInternally) {
    try {
      await backend.management.logUse({ grantId, vault: args.vault, secretName: args.secret, reason: args.reason, requester });
    } catch (err: any) {
      console.error(`Access to "${args.secret}" was refused: ${err?.message ?? err}`);
      return 1;
    }
  }

  let value: string;
  try {
    value = await target.provider.getSecret(target.readId, { purpose: args.reason, grantId });
  } catch (err: any) {
    console.error(`Failed to read "${args.secret}": ${err?.message ?? err}`);
    return 1;
  }

  if (grant.autoApproved) {
    console.error("[Auto-approved — active approval window]");
  }

  // The ONLY stdout write in this command — the raw secret value, nothing else.
  process.stdout.write(value);
  return 0;
}
