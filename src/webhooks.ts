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
}

export class WebhookDispatcher {
  private endpoints: ResolvedWebhookConfig[];

  constructor(endpoints: ResolvedWebhookConfig[]) {
    this.endpoints = endpoints;
    if (endpoints.length > 0) {
      console.error(`  Webhooks: ${endpoints.length} endpoint(s) configured`);
    }
  }

  /**
   * Dispatch an access event to all matching webhook endpoints.
   * Fires and forgets — webhook failures are logged but never block the agent.
   */
  dispatch(event: AccessEvent): void {
    for (const endpoint of this.endpoints) {
      if (!this.shouldSend(endpoint, event.action)) continue;

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
          event: "secret_access",
          ...event,
        }),
      }).catch((err) => {
        console.error(`Webhook delivery failed for ${endpoint.url}: ${err.message}`);
      });
    }
  }

  private shouldSend(
    endpoint: ResolvedWebhookConfig,
    action: AccessEvent["action"]
  ): boolean {
    if (endpoint.events === "all") return true;
    return endpoint.events.includes(action);
  }
}
