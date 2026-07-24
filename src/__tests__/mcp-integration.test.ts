import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApprovalServer, formatRequester } from "../approval.js";
import { AuditLog } from "../audit.js";
import { WebhookDispatcher } from "../webhooks.js";
import { createMcpServer, type VaultInstance } from "../server.js";
import type { SecretProvider } from "../providers/provider.js";

interface Call {
  url: string;
  opts: { body: string; headers: Record<string, string> };
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

function postApprove(port: number, id: string, decision: "yes" | "no"): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/approve/${id}/${decision}`, method: "POST" },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const flush = () => new Promise((r) => setTimeout(r, 20));

/** Fake in-memory secret provider for tests — never touches disk or a real vault. */
function fakeProvider(): SecretProvider {
  const store = new Map([["API_KEY", "super-secret-value-12345"]]);
  return {
    name: "fake",
    async listSecrets() {
      return [...store.keys()].map((name) => ({ id: name, name }));
    },
    async getSecret(id: string) {
      const v = store.get(id);
      if (!v) throw new Error("not found");
      return v;
    },
  };
}

async function setup(port: number) {
  const fetchMock = mockFetch();
  const audit = new AuditLog(":memory:");
  const webhooks = new WebhookDispatcher([
    { url: "https://logs.example.test/events", events: "all", format: "json" },
  ]);
  const approval = new ApprovalServer(port, webhooks);
  await approval.start(); // no ngrok token -> falls back to http://localhost:<port>

  const vaults: VaultInstance[] = [
    { name: "dev", provider: fakeProvider(), ttlMinutes: 0, ttlScope: "secret", writable: false },
  ];

  const mcpServer = createMcpServer({ vaults, approval, audit, webhooks });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  return { fetchMock, audit, webhooks, approval, client, mcpServer };
}

test("get_secret: approval flow — pending fires once, resolution fires once, secret returned only after approval", async () => {
  const port = 39501;
  const { fetchMock, audit, approval, client } = await setup(port);
  try {
    const callPromise = client.callTool({
      name: "get_secret",
      arguments: {
        vault: "dev",
        name: "API_KEY",
        reason: "test reason",
        requesterId: "churn-preset",
        taskId: "task-142",
      },
    });

    await flush();

    // The request must be tracked in the pending map (multi-worker support).
    const pending = (approval as unknown as { pending: Map<string, any> }).pending;
    assert.equal(pending.size, 1);
    const [id, request] = [...pending.entries()][0];

    // Attribution flows into the tracked request (used by the rendered approval page).
    assert.equal(request.requesterId, "churn-preset");
    assert.equal(request.taskId, "task-142");
    assert.match(formatRequester(request), /task-142 \/ churn-preset/);
    assert.match(formatRequester(request), /API_KEY/);

    // Exactly one "pending" webhook fired at creation time, before resolution.
    const pendingCalls = fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_pending");
    assert.equal(pendingCalls.length, 1);
    const pendingBody = JSON.parse(pendingCalls[0].opts.body);
    assert.equal(pendingBody.requesterId, "churn-preset");
    assert.equal(pendingBody.taskId, "task-142");
    assert.match(pendingBody.approvalUrl, /\/approve\//);

    // No resolution event yet — nothing has been approved/denied.
    assert.equal(fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_access").length, 0);

    await postApprove(port, id, "yes");
    const result = await callPromise;

    // The secret is only returned to the agent AFTER approval.
    const text = (result.content as any[])[0].text as string;
    assert.match(text, /super-secret-value-12345/);

    // Exactly one resolution ("approved") event fired, and pending still only fired once.
    const approvedCalls = fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_access" && JSON.parse(c.opts.body).action === "approved");
    assert.equal(approvedCalls.length, 1);
    assert.equal(fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_pending").length, 1);

    // Attribution reached the audit log.
    const rows = (audit as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1")
      .all() as any[];
    assert.equal(rows[0].requester_id, "churn-preset");
    assert.equal(rows[0].task_id, "task-142");

    // ── THE CRITICAL SECURITY INVARIANT ──────────────────────────────────
    // The approval URL and the pending-request ID must NEVER appear anywhere
    // in the MCP tool response object returned to the calling agent. This is
    // the structural mitigation against co-located agent self-approval
    // (SECURITY_WHITEPAPER.md §2.2) — the agent must only ever learn whether
    // it was approved or denied, never the URL/ID it could use to approve
    // itself or discover other pending requests.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("/approve/"), "tool response must not contain an approval URL path");
    assert.ok(!serialized.includes(id), "tool response must not contain the pending-request ID");
  } finally {
    fetchMock.restore();
    await approval.stop();
  }
});

test("get_secret: denial flow — pending fires once, denied resolution fires once, no secret leaked, invariant holds", async () => {
  const port = 39502;
  const { fetchMock, approval, client } = await setup(port);
  try {
    const callPromise = client.callTool({
      name: "get_secret",
      arguments: { vault: "dev", name: "API_KEY", reason: "test reason" }, // no requesterId — must still work (backward compat)
    });

    await flush();
    const pending = (approval as unknown as { pending: Map<string, any> }).pending;
    const [id, request] = [...pending.entries()][0];

    // Omitted attribution displays as "unknown worker", not an error.
    assert.match(formatRequester(request), /unknown worker/);

    await postApprove(port, id, "no");
    const result = await callPromise;

    const text = (result.content as any[])[0].text as string;
    assert.match(text, /DENIED/);
    assert.ok(!text.includes("super-secret-value"));

    const pendingCalls = fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_pending");
    assert.equal(pendingCalls.length, 1);
    const deniedCalls = fetchMock.calls.filter((c) => JSON.parse(c.opts.body).event === "secret_access" && JSON.parse(c.opts.body).action === "denied");
    assert.equal(deniedCalls.length, 1);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("/approve/"));
    assert.ok(!serialized.includes(id));
  } finally {
    fetchMock.restore();
    await approval.stop();
  }
});
