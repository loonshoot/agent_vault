import type { ResolvedWebhookConfig } from "./config.js";

export interface AccessEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** The vault that was accessed */
  vault: string;
  /** The secret name(s) requested */
  secrets: string[];
  /** The reason the agent provided */
  reason: string;
  /** What happened */
  action: "approved" | "denied" | "auto_approved";
  /** Whether the approval covered one secret or the whole vault */
  scope: "secret" | "vault";
  /** When the approval window expires (if applicable) */
  ttlExpiresAt: string | null;
  /** Identity of the requesting worker/agent, if provided */
  requesterId?: string;
  /** Task or job identifier the request was made on behalf of, if provided */
  taskId?: string;
  /** Branch or workspace identifier, if provided */
  branch?: string;
}

/**
 * Fired the instant a request is CREATED, before any human has acted on it.
 * This is the event that closes the "pending" observability gap: approved /
 * denied / auto_approved events only fire AFTER a human (or the TTL cache)
 * has already resolved the request, so nothing today tells a human "a worker
 * is blocked right now." Subscribe to "pending" events (e.g. via ntfy.sh) to
 * get pushed the moment any worker needs a decision.
 *
 * `approvalUrl` is included deliberately — this event only ever goes to
 * webhook endpoints the human configured (their own logging/notification
 * channel), which is the same out-of-band channel that already receives the
 * approval link via the terminal/console. It is never included in any MCP
 * tool response returned to the calling agent.
 */
export interface PendingEvent {
  timestamp: string;
  vault: string;
  secrets: string[];
  reason: string;
  action: "pending";
  requesterId?: string;
  taskId?: string;
  branch?: string;
  approvalUrl: string;
}

export type DispatchableEvent = AccessEvent | PendingEvent;

export class WebhookDispatcher {
  private endpoints: ResolvedWebhookConfig[];

  constructor(endpoints: ResolvedWebhookConfig[]) {
    this.endpoints = endpoints;
    if (endpoints.length > 0) {
      console.error(`  Webhooks: ${endpoints.length} endpoint(s) configured`);
    }
  }

  /**
   * Dispatch a resolved access event (approved/denied/auto_approved) to all
   * matching webhook endpoints. Fires and forgets — webhook failures are
   * logged but never block the agent.
   */
  dispatch(event: AccessEvent): void {
    this.send(event, event.action);
  }

  /**
   * Dispatch a "pending" event the moment a request is created — the only
   * event that fires BEFORE a human has acted, i.e. the signal a push
   * notification channel actually needs.
   */
  dispatchPending(event: PendingEvent): void {
    this.send(event, "pending");
  }

  private send(
    event: DispatchableEvent,
    action: "pending" | "approved" | "denied" | "auto_approved"
  ): void {
    for (const endpoint of this.endpoints) {
      if (!this.shouldSend(endpoint, action)) continue;

      if (endpoint.format === "ntfy") {
        this.sendNtfy(endpoint, event);
        continue;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "agent-vault/0.1.0",
      };
      if (endpoint.authorization) {
        headers["Authorization"] = endpoint.authorization;
      }

      fetch(endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          event: event.action === "pending" ? "secret_pending" : "secret_access",
          ...event,
        }),
      }).catch((err) => {
        console.error(`Webhook delivery failed for ${endpoint.url}: ${err.message}`);
      });
    }
  }

  /**
   * ntfy.sh (https://ntfy.sh) accepts a plain-text POST body as the
   * notification message when posted directly to a topic URL
   * (https://ntfy.sh/<topic>), plus optional `X-Title` / `X-Priority` /
   * `X-Click` headers for a richer notification. This renders a real,
   * readable push notification instead of a raw JSON dump.
   */
  private sendNtfy(endpoint: ResolvedWebhookConfig, event: DispatchableEvent): void {
    const who = [event.taskId, event.requesterId].filter(Boolean).join(" / ") || "unknown worker";
    const secrets = event.secrets.join(", ");

    let title: string;
    let message: string;
    let priority = "3"; // default
    let click: string | undefined;

    if (event.action === "pending") {
      title = `Agent Vault: approval needed`;
      message = `Worker: ${who} requests ${secrets}\nVault: ${event.vault}\nReason: ${event.reason}`;
      priority = "5"; // urgent — a worker is blocked right now
      click = event.approvalUrl;
    } else {
      title = `Agent Vault: ${event.action}`;
      message = `Worker: ${who} — ${secrets}\nVault: ${event.vault}\nReason: ${event.reason}`;
      priority = event.action === "denied" ? "4" : "3";
    }

    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "User-Agent": "agent-vault/0.1.0",
      "X-Title": title,
      "X-Priority": priority,
    };
    if (click) headers["X-Click"] = click;
    if (endpoint.authorization) headers["Authorization"] = endpoint.authorization;

    fetch(endpoint.url, {
      method: "POST",
      headers,
      body: message,
    }).catch((err) => {
      console.error(`Webhook delivery failed for ${endpoint.url}: ${err.message}`);
    });
  }

  private shouldSend(
    endpoint: ResolvedWebhookConfig,
    action: "pending" | "approved" | "denied" | "auto_approved"
  ): boolean {
    if (endpoint.events === "all") return true;
    return endpoint.events.includes(action);
  }
}
