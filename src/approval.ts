import express from "express";
import ngrok from "@ngrok/ngrok";
import { nanoid } from "nanoid";
import type { Server } from "node:http";
import type { WebhookDispatcher } from "./webhooks.js";

export interface ApprovalRequest {
  id: string;
  secretName: string;
  reason: string;
  /** For write requests: "write", for read requests: "read" */
  action: "read" | "write";
  /** Masked preview of the value for write requests */
  maskedValue?: string;
  /** Identity of the requesting worker/agent, if provided (multi-worker attribution) */
  requesterId?: string;
  /** Task or job identifier the request was made on behalf of, if provided */
  taskId?: string;
  /** Branch or workspace identifier, if provided */
  branch?: string;
  createdAt: Date;
  resolve: (approved: boolean) => void;
}

export class ApprovalServer {
  private app = express();
  private server: Server | null = null;
  private publicUrl: string | null = null;
  private pending = new Map<string, ApprovalRequest>();

  /**
   * `webhooks` is optional so ApprovalServer can still be constructed and used
   * standalone (e.g. in tests) without wiring up the full webhook dispatcher.
   * When present, a "pending" event fires the instant requestApproval() creates
   * a request — this is what closes the "nothing tells a human a worker is
   * blocked right now" gap. Multiple simultaneous requests are already
   * supported via the `pending` map; this just adds a push signal per request.
   */
  constructor(private port: number = 9999, private webhooks?: WebhookDispatcher) {
    this.setupRoutes();
  }

  private setupRoutes() {
    // Dashboard showing all pending approval requests
    this.app.get("/", (req, res) => {
      if (this.pending.size === 0) {
        res.send(this.renderPage("Agent Vault", "<p>No pending approval requests.</p>"));
        return;
      }
      const items = Array.from(this.pending.values())
        .map((r) => {
          const badge = r.action === "write"
            ? `<span class="badge write">WRITE</span>`
            : `<span class="badge read">READ</span>`;
          return `<div class="request-info" style="margin-bottom:16px;padding:12px;border:1px solid #333;border-radius:8px">
            <p>${badge} <strong>${escapeHtml(r.secretName)}</strong></p>
            <p style="font-size:12px;color:#777">${escapeHtml(formatRequester(r))}</p>
            <p style="font-size:13px;color:#999">${escapeHtml(r.reason)}</p>
            <div class="actions" style="margin-top:8px">
              <form method="POST" action="/approve/${r.id}/yes" style="display:inline">
                <button type="submit" class="btn approve">Approve</button>
              </form>
              <form method="POST" action="/approve/${r.id}/no" style="display:inline">
                <button type="submit" class="btn deny">Deny</button>
              </form>
            </div>
          </div>`;
        })
        .join("");
      res.send(this.renderPage("Pending Approvals", items));
    });

    this.app.get("/approve/:id", (req, res) => {
      const request = this.pending.get(req.params.id);
      if (!request) {
        res.status(404).send(this.renderPage("Request Not Found", "This approval request has expired or already been handled."));
        return;
      }

      const actionLabel = request.action === "write" ? "Write Secret Request" : "Secret Access Request";
      const actionBadge = request.action === "write"
        ? `<span class="badge write">WRITE</span>`
        : `<span class="badge read">READ</span>`;
      const maskedLine = request.maskedValue
        ? `<p><strong>Value preview:</strong> <code>${escapeHtml(request.maskedValue)}</code></p>`
        : "";

      res.send(this.renderPage(
        actionLabel,
        `<div class="request-info">
          <p>${actionBadge} <strong>Secret:</strong> ${escapeHtml(request.secretName)}</p>
          <p><strong>${escapeHtml(formatRequester(request))}</strong></p>
          ${maskedLine}
          <p><strong>Reason:</strong> ${escapeHtml(request.reason)}</p>
          <p><strong>Requested:</strong> ${request.createdAt.toLocaleString()}</p>
        </div>
        <div class="actions">
          <form method="POST" action="/approve/${request.id}/yes" style="display:inline">
            <button type="submit" class="btn approve">Approve</button>
          </form>
          <form method="POST" action="/approve/${request.id}/no" style="display:inline">
            <button type="submit" class="btn deny">Deny</button>
          </form>
        </div>`
      ));
    });

    this.app.post("/approve/:id/yes", (req, res) => {
      const request = this.pending.get(req.params.id);
      if (!request) {
        res.status(404).send(this.renderPage("Expired", "This request has already been handled."));
        return;
      }
      this.pending.delete(req.params.id);
      request.resolve(true);
      res.send(this.renderPage("Approved", `<p class="result approved">Access to <strong>${escapeHtml(request.secretName)}</strong> has been approved.</p>`));
    });

    this.app.post("/approve/:id/no", (req, res) => {
      const request = this.pending.get(req.params.id);
      if (!request) {
        res.status(404).send(this.renderPage("Expired", "This request has already been handled."));
        return;
      }
      this.pending.delete(req.params.id);
      request.resolve(false);
      res.send(this.renderPage("Denied", `<p class="result denied">Access to <strong>${escapeHtml(request.secretName)}</strong> has been denied.</p>`));
    });
  }

  async start(ngrokAuthToken?: string): Promise<string> {
    const token = ngrokAuthToken || process.env.NGROK_AUTHTOKEN;

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, async () => {
        if (token) {
          try {
            const listener = await ngrok.connect({
              addr: this.port,
              authtoken: token,
            });
            this.publicUrl = listener.url()!;
            resolve(this.publicUrl);
          } catch (err) {
            console.error(`Warning: ngrok failed (${err}) — falling back to localhost`);
            this.publicUrl = `http://localhost:${this.port}`;
            resolve(this.publicUrl);
          }
        } else {
          // No ngrok token — fall back to localhost (good for local testing)
          this.publicUrl = `http://localhost:${this.port}`;
          console.error("No NGROK_AUTHTOKEN set — running in local-only mode (approval links use localhost)");
          resolve(this.publicUrl);
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Reject all pending requests
    for (const [, request] of this.pending) {
      request.resolve(false);
    }
    this.pending.clear();
    if (this.publicUrl && !this.publicUrl.startsWith("http://localhost")) {
      await ngrok.disconnect();
    }
    if (this.server) {
      this.server.close();
    }
  }

  /**
   * Create an approval request and return the public URL.
   * The returned promise resolves to `true` (approved) or `false` (denied)
   * when the user clicks the link.
   *
   * SECURITY INVARIANT: `url` (and the underlying pending-request `id`) must
   * NEVER be included in an MCP tool response returned to the calling agent —
   * callers in server.ts only console.error() it and await `waitForApproval`.
   * This is a structural mitigation against the co-located agent self-approval
   * attack documented in SECURITY_WHITEPAPER.md §2.2. Do not change that.
   *
   * `vault`/`secrets` (structured, for webhook payloads) and `requesterId` /
   * `taskId` / `branch` (attribution, for display + audit + webhooks) are all
   * optional — omitting them keeps existing callers working unchanged and
   * renders as "unknown worker" wherever attribution is shown.
   */
  requestApproval(
    secretName: string,
    reason: string,
    options?: {
      action?: "read" | "write";
      maskedValue?: string;
      vault?: string;
      secrets?: string[];
      requesterId?: string;
      taskId?: string;
      branch?: string;
    }
  ): { url: string; waitForApproval: Promise<boolean> } {
    const id = nanoid(16);
    const url = `${this.publicUrl}/approve/${id}`;

    const waitForApproval = new Promise<boolean>((resolve) => {
      this.pending.set(id, {
        id,
        secretName,
        reason,
        action: options?.action ?? "read",
        maskedValue: options?.maskedValue,
        requesterId: options?.requesterId,
        taskId: options?.taskId,
        branch: options?.branch,
        createdAt: new Date(),
        resolve,
      });
    });

    // Fire the "pending" webhook event the instant the request is created —
    // i.e. before any human has acted. This is the only event that can back a
    // real push notification ("a worker is blocked right now"); approved/
    // denied/auto_approved only fire after resolution. The approval `url` is
    // included here deliberately: this event only ever reaches endpoints the
    // human configured themselves (their own notification channel), the same
    // out-of-band trust boundary as the console.error'd link. It is never
    // part of the object returned from this method's `url`/tool-response path
    // to the agent beyond what already happens today.
    this.webhooks?.dispatchPending({
      timestamp: new Date().toISOString(),
      vault: options?.vault ?? "",
      secrets: options?.secrets ?? [secretName],
      reason,
      action: "pending",
      requesterId: options?.requesterId,
      taskId: options?.taskId,
      branch: options?.branch,
      approvalUrl: url,
    });

    return { url, waitForApproval };
  }

  private renderPage(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Vault - ${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a; color: #e0e0e0;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; padding: 20px;
    }
    .card {
      background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
      padding: 32px; max-width: 420px; width: 100%;
    }
    h1 { font-size: 20px; margin-bottom: 20px; color: #fff; }
    .request-info { margin-bottom: 24px; }
    .request-info p { margin-bottom: 8px; font-size: 15px; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px; margin-right: 6px;
      vertical-align: middle;
    }
    .badge.read { background: #1e3a5f; color: #60a5fa; }
    .badge.write { background: #5f1e3a; color: #f472b6; }
    code { background: #2a2a2a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .actions { display: flex; gap: 12px; }
    .btn {
      flex: 1; padding: 14px 24px; border: none; border-radius: 8px;
      font-size: 16px; font-weight: 600; cursor: pointer;
    }
    .btn.approve { background: #22c55e; color: #000; }
    .btn.approve:hover { background: #16a34a; }
    .btn.deny { background: #ef4444; color: #fff; }
    .btn.deny:hover { background: #dc2626; }
    .result { font-size: 16px; padding: 16px; border-radius: 8px; }
    .result.approved { background: #052e16; border: 1px solid #22c55e; }
    .result.denied { background: #2d0a0a; border: 1px solid #ef4444; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </div>
</body>
</html>`;
  }
}

/**
 * Render a human-readable attribution line, e.g.
 * "Worker: task-142 / churn-preset requests HUBSPOT_SANDBOX_TOKEN".
 * Falls back to "Worker: unknown worker" when no identity was provided —
 * this keeps callers that omit requesterId/taskId/branch working unchanged.
 */
export function formatRequester(r: Pick<ApprovalRequest, "taskId" | "requesterId" | "branch" | "secretName">): string {
  const parts = [r.taskId, r.requesterId].filter(Boolean);
  const who = parts.length ? parts.join(" / ") : "unknown worker";
  const branchSuffix = r.branch ? ` (branch: ${r.branch})` : "";
  return `Worker: ${who} requests ${r.secretName}${branchSuffix}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
