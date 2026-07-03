import { test } from "node:test";
import assert from "node:assert/strict";
import { WebhookDispatcher } from "../webhooks.js";

interface Call {
  url: string;
  opts: { method: string; headers: Record<string, string>; body: string };
}

function mockFetch(): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, opts: any) => {
    calls.push({ url, opts });
    return { ok: true } as Response;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

test("dispatchPending sends a 'secret_pending' JSON event including the approval URL", async () => {
  const { calls, restore } = mockFetch();
  try {
    const dispatcher = new WebhookDispatcher([
      { url: "https://logs.example.com/events", events: "all", format: "json" },
    ]);
    dispatcher.dispatchPending({
      timestamp: "2026-01-01T00:00:00.000Z",
      vault: "dev",
      secrets: ["HUBSPOT_SANDBOX_TOKEN"],
      reason: "sync churn data",
      action: "pending",
      requesterId: "churn-preset",
      taskId: "task-142",
      approvalUrl: "https://abc123.ngrok-free.app/approve/xK9mQ2",
    });
    await flush();
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.event, "secret_pending");
    assert.equal(body.action, "pending");
    assert.equal(body.approvalUrl, "https://abc123.ngrok-free.app/approve/xK9mQ2");
    assert.equal(body.requesterId, "churn-preset");
    assert.equal(body.taskId, "task-142");
  } finally {
    restore();
  }
});

test("resolution events (approved/denied/auto_approved) still fire via dispatch()", async () => {
  const { calls, restore } = mockFetch();
  try {
    const dispatcher = new WebhookDispatcher([
      { url: "https://logs.example.com/events", events: "all", format: "json" },
    ]);
    dispatcher.dispatch({
      timestamp: "2026-01-01T00:00:01.000Z",
      vault: "dev",
      secrets: ["HUBSPOT_SANDBOX_TOKEN"],
      reason: "sync churn data",
      action: "approved",
      scope: "secret",
      ttlExpiresAt: null,
    });
    await flush();
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.event, "secret_access");
    assert.equal(body.action, "approved");
  } finally {
    restore();
  }
});

test("event filtering: an endpoint subscribed only to 'approved' does not receive 'pending'", async () => {
  const { calls, restore } = mockFetch();
  try {
    const dispatcher = new WebhookDispatcher([
      { url: "https://logs.example.com/events", events: ["approved"], format: "json" },
    ]);
    dispatcher.dispatchPending({
      timestamp: "2026-01-01T00:00:00.000Z",
      vault: "dev",
      secrets: ["X"],
      reason: "r",
      action: "pending",
      approvalUrl: "https://example.com/approve/1",
    });
    await flush();
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("ntfy format sends a readable plain-text message with title/priority/click headers", async () => {
  const { calls, restore } = mockFetch();
  try {
    const dispatcher = new WebhookDispatcher([
      { url: "https://ntfy.sh/agent-vault-demo-topic", events: ["pending"], format: "ntfy" },
    ]);
    dispatcher.dispatchPending({
      timestamp: "2026-01-01T00:00:00.000Z",
      vault: "dev",
      secrets: ["HUBSPOT_SANDBOX_TOKEN"],
      reason: "sync churn data",
      action: "pending",
      requesterId: "churn-preset",
      taskId: "task-142",
      approvalUrl: "https://abc123.ngrok-free.app/approve/xK9mQ2",
    });
    await flush();
    assert.equal(calls.length, 1);
    const { opts } = calls[0];
    assert.equal(opts.headers["Content-Type"], "text/plain; charset=utf-8");
    assert.equal(opts.headers["X-Click"], "https://abc123.ngrok-free.app/approve/xK9mQ2");
    assert.equal(opts.headers["X-Priority"], "5");
    assert.match(opts.body, /task-142 \/ churn-preset/);
    assert.match(opts.body, /HUBSPOT_SANDBOX_TOKEN/);
    // The raw body must be human-readable text, not a JSON blob.
    assert.throws(() => JSON.parse(opts.body));
  } finally {
    restore();
  }
});
