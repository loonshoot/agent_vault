import express from "express";
import ngrok from "@ngrok/ngrok";
import { nanoid } from "nanoid";
import type { Server } from "node:http";

export interface ApprovalRequest {
  id: string;
  secretName: string;
  reason: string;
  createdAt: Date;
  resolve: (approved: boolean) => void;
}

export class ApprovalServer {
  private app = express();
  private server: Server | null = null;
  private publicUrl: string | null = null;
  private pending = new Map<string, ApprovalRequest>();

  constructor(private port: number = 9999) {
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.get("/approve/:id", (req, res) => {
      const request = this.pending.get(req.params.id);
      if (!request) {
        res.status(404).send(this.renderPage("Request Not Found", "This approval request has expired or already been handled."));
        return;
      }

      res.send(this.renderPage(
        "Secret Access Request",
        `<div class="request-info">
          <p><strong>Secret:</strong> ${escapeHtml(request.secretName)}</p>
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
            reject(new Error(`Failed to start ngrok tunnel: ${err}`));
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
   */
  requestApproval(secretName: string, reason: string): { url: string; waitForApproval: Promise<boolean> } {
    const id = nanoid(16);
    const url = `${this.publicUrl}/approve/${id}`;

    const waitForApproval = new Promise<boolean>((resolve) => {
      this.pending.set(id, {
        id,
        secretName,
        reason,
        createdAt: new Date(),
        resolve,
      });
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
