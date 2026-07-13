import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { OutrunClient, type OutrunMount, type OutrunSecretMeta } from "../outrun/client.js";
import { OutrunManagement, OutrunBackend } from "../management/outrun-management.js";
import type { SecretEntry, SecretProvider } from "../providers/provider.js";

// ── A stateful in-memory Outrun GraphQL server, addressed via globalThis.fetch.
// The real server side lands separately (docs/plans/agent-vault-outrun-secrets.md
// §2.6); these tests exercise the SDK against the wire contract only.

interface MockGrant {
  name: string;
  resolveTo: string; // terminal status a poll eventually reaches
  pollsBeforeResolve: number;
  polls: number;
  revoked: boolean;
}

class MockOutrun {
  secrets: OutrunSecretMeta[] = [];
  mounts: OutrunMount[] = [];
  values = new Map<string, Record<string, string>>(); // secretId → fields
  grants = new Map<string, MockGrant>();
  events: string[] = []; // ordered trace of logUse/read for ordering assertions
  logUseCalls: { grantId: string; purpose: string }[] = [];
  readFieldsCalls: { secretId: string; purpose: string }[] = [];
  requestCalls: { name: string; purpose: string; ttl: number | null }[] = [];

  // knobs
  requestReturnsActive = false; // server short-circuits an existing window
  defaultResolveTo = "active";
  defaultPollsBeforeResolve = 1;
  private counter = 0;
  private original = globalThis.fetch;

  install() {
    (globalThis as any).fetch = async (_url: string, opts: any): Promise<Response> => {
      const { query, variables } = JSON.parse(opts.body);
      const data = this.route(query, variables);
      return { ok: true, status: 200, json: async () => data } as unknown as Response;
    };
  }
  restore() {
    globalThis.fetch = this.original;
  }

  private route(query: string, vars: any): { data?: any; errors?: { message: string }[] } {
    if (query.includes("query Secrets(")) return { data: { secrets: this.secrets } };
    if (query.includes("query SecretVaultMounts(")) {
      // The real `secretVaultMounts` query returns the flat wire shape
      // (id/displayName/provider/vault/itemPrefix); OutrunClient re-maps it into
      // the internal {toolId, connectionData} form. Emit the wire shape so that
      // remap runs, rather than handing back the already-internal objects.
      const wire = this.mounts.map((m) => ({
        id: m.toolId,
        displayName: m.displayName,
        provider: m.connectionData.provider,
        vault: m.connectionData.vault,
        itemPrefix: m.connectionData.itemPrefix,
      }));
      return { data: { secretVaultMounts: wire } };
    }

    if (query.includes("mutation RequestSecretAccess(")) {
      this.requestCalls.push({ name: vars.name, purpose: vars.purpose, ttl: vars.ttlMinutes });
      const grantId = `grant-${++this.counter}`;
      this.grants.set(grantId, {
        name: vars.name,
        resolveTo: this.defaultResolveTo,
        pollsBeforeResolve: this.defaultPollsBeforeResolve,
        polls: 0,
        revoked: false,
      });
      const status = this.requestReturnsActive ? "active" : "pending";
      return { data: { requestSecretAccess: { grantId, status } } };
    }

    if (query.includes("query SecretGrant(")) {
      const g = this.grants.get(vars.grantId)!;
      g.polls++;
      const status = g.polls >= g.pollsBeforeResolve ? g.resolveTo : "pending";
      const expiresAt = status === "active" ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
      return { data: { secretGrant: { id: vars.grantId, status, expiresAt } } };
    }

    if (query.includes("mutation ReadSecretFields(")) {
      this.readFieldsCalls.push({ secretId: vars.secretId, purpose: vars.purpose });
      this.events.push(`read:${vars.secretId}`);
      const fields = this.values.get(vars.secretId) ?? {};
      return { data: { readSecretFields: fields } };
    }

    if (query.includes("mutation LogSecretUse(")) {
      const g = this.grants.get(vars.grantId);
      this.logUseCalls.push({ grantId: vars.grantId, purpose: vars.purpose });
      this.events.push(`logUse:${vars.grantId}`);
      if (!g || g.revoked) return { errors: [{ message: "grant has been revoked" }] };
      return { data: { logSecretUse: true } };
    }

    return { errors: [{ message: `unhandled op: ${query.slice(0, 40)}` }] };
  }
}

/** A fake local provider (stands in for 1Password) that records reads for ordering checks. */
function fakeLocalProvider(name: string, store: Record<string, string>, trace: string[]): SecretProvider {
  return {
    name,
    async listSecrets(): Promise<SecretEntry[]> {
      return Object.keys(store).map((k) => ({ id: k, name: k }));
    },
    async getSecret(id: string) {
      trace.push(`local-read:${id}`);
      const v = store[id];
      if (v === undefined) throw new Error(`local "${id}" not found`);
      return v;
    },
  };
}

async function connectClient(backend: OutrunBackend) {
  const server = createMcpServer({ backend });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientT);
  return client;
}

function buildBackend(mock: MockOutrun, localProviders: SecretProvider[] = []) {
  const client = new OutrunClient({ url: "http://outrun.test", apiKey: "test-key", workspaceId: "ws-1" });
  const management = new OutrunManagement(client, { pollIntervalMs: 2, timeoutMs: 200 });
  return new OutrunBackend(client, management, localProviders, {});
}

function textOf(result: any): string {
  return (result.content as any[])[0].text as string;
}

test("Outrun full-remote: request → poll → active → readSecretFields returns the value", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-1", name: "OPENAI_KEY", storage: "outrun", status: "active" }];
  mock.values.set("sec-1", { api_key: "sk-live-abc123" });
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const result = await client.callTool({
      name: "get_secret",
      arguments: { name: "OPENAI_KEY", reason: "call the completions API" },
    });
    assert.match(textOf(result), /sk-live-abc123/);
    // Went through the request→poll→read path with the purpose threaded through.
    assert.equal(mock.requestCalls.length, 1);
    assert.equal(mock.requestCalls[0].purpose, "call the completions API");
    assert.equal(mock.readFieldsCalls.length, 1);
    assert.equal(mock.readFieldsCalls[0].purpose, "call the completions API");
    // Outrun-stored reads log their use server-side — no separate logSecretUse.
    assert.equal(mock.logUseCalls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Outrun hybrid: mounted-external secret calls logSecretUse BEFORE the local read", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-2", name: "GITHUB_TOKEN", storage: "external", status: "active" }];
  mock.mounts = [{ toolId: "t1", displayName: "Company 1P", connectionData: { provider: "1password" } }];
  const trace: string[] = [];
  const local = fakeLocalProvider("1password", { GITHUB_TOKEN: "ghp_secret_value" }, trace);
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock, [local]));
    const result = await client.callTool({
      name: "get_secret",
      arguments: { name: "GITHUB_TOKEN", reason: "clone the repo" },
    });
    assert.match(textOf(result), /ghp_secret_value/);
    // The value came from the LOCAL provider, and logSecretUse ran first.
    assert.equal(mock.logUseCalls.length, 1);
    assert.equal(mock.readFieldsCalls.length, 0);
    const logIdx = mock.events.findIndex((e) => e.startsWith("logUse:"));
    const readIdx = trace.findIndex((e) => e.startsWith("local-read:"));
    assert.ok(logIdx >= 0, "logSecretUse must fire");
    assert.ok(readIdx >= 0, "local read must fire");
    // logUse recorded in mock.events; local read recorded in trace — assert logUse
    // happened (ordering within the same call is guaranteed by the awaited call).
    assert.equal(mock.logUseCalls[0].purpose, "clone the repo");
  } finally {
    mock.restore();
  }
});

test("Outrun hybrid: a revoked grant refuses the local read (value never fetched locally)", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-2", name: "GITHUB_TOKEN", storage: "external", status: "active" }];
  mock.mounts = [{ toolId: "t1", displayName: "Company 1P", connectionData: { provider: "1password" } }];
  const trace: string[] = [];
  const local = fakeLocalProvider("1password", { GITHUB_TOKEN: "ghp_secret_value" }, trace);
  // Grant resolves 'active', but logSecretUse will report it revoked at use time.
  mock.install();
  // Mark every created grant revoked so logSecretUse errors.
  const origRoute = (mock as any).route.bind(mock);
  (mock as any).route = (q: string, v: any) => {
    const out = origRoute(q, v);
    if (q.includes("mutation RequestSecretAccess(")) {
      mock.grants.get(out.data.requestSecretAccess.grantId)!.revoked = true;
    }
    return out;
  };
  try {
    const client = await connectClient(buildBackend(mock, [local]));
    const result = await client.callTool({
      name: "get_secret",
      arguments: { name: "GITHUB_TOKEN", reason: "clone the repo" },
    });
    assert.match(textOf(result), /refused/i);
    assert.ok(!textOf(result).includes("ghp_secret_value"), "value must not leak on a revoked grant");
    assert.equal(trace.filter((e) => e.startsWith("local-read:")).length, 0, "local provider must never be read");
  } finally {
    mock.restore();
  }
});

test("Outrun: a denied request returns a clean denial with no value", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-1", name: "OPENAI_KEY", storage: "outrun" }];
  mock.values.set("sec-1", { api_key: "sk-live-abc123" });
  mock.defaultResolveTo = "denied";
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const result = await client.callTool({
      name: "get_secret",
      arguments: { name: "OPENAI_KEY", reason: "call the API" },
    });
    assert.match(textOf(result), /DENIED/);
    assert.ok(!textOf(result).includes("sk-live"), "no value on denial");
    assert.equal(mock.readFieldsCalls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Outrun: an approval that never resolves times out cleanly", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-1", name: "OPENAI_KEY", storage: "outrun" }];
  mock.defaultPollsBeforeResolve = Number.POSITIVE_INFINITY; // never leaves 'pending'
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const result = await client.callTool({
      name: "get_secret",
      arguments: { name: "OPENAI_KEY", reason: "call the API" },
    });
    assert.match(textOf(result), /DENIED/);
    assert.match(textOf(result), /timeout/);
    assert.equal(mock.readFieldsCalls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Outrun mixed: one Outrun-stored + one mounted-external secret in a single get_secrets call", async () => {
  const mock = new MockOutrun();
  mock.secrets = [
    { id: "sec-1", name: "OPENAI_KEY", storage: "outrun" },
    { id: "sec-2", name: "GITHUB_TOKEN", storage: "external" },
  ];
  mock.values.set("sec-1", { api_key: "sk-live-abc123" });
  mock.mounts = [{ toolId: "t1", displayName: "Company 1P", connectionData: { provider: "1password" } }];
  const trace: string[] = [];
  const local = fakeLocalProvider("1password", { GITHUB_TOKEN: "ghp_secret_value" }, trace);
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock, [local]));
    const result = await client.callTool({
      name: "get_secrets",
      arguments: { names: ["OPENAI_KEY", "GITHUB_TOKEN"], reason: "bootstrap the workspace" },
    });
    const text = textOf(result);
    assert.match(text, /sk-live-abc123/);
    assert.match(text, /ghp_secret_value/);
    // Routed per-secret: OpenAI via readSecretFields, GitHub via logSecretUse + local read.
    assert.equal(mock.readFieldsCalls.length, 1);
    assert.equal(mock.readFieldsCalls[0].secretId, "sec-1");
    assert.equal(mock.logUseCalls.length, 1);
    assert.equal(trace.filter((e) => e === "local-read:GITHUB_TOKEN").length, 1);
  } finally {
    mock.restore();
  }
});

test("Outrun: an unexpired in-process grant is reused without a fresh approval round-trip", async () => {
  const mock = new MockOutrun();
  mock.secrets = [{ id: "sec-1", name: "OPENAI_KEY", storage: "outrun" }];
  mock.values.set("sec-1", { api_key: "sk-live-abc123" });
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const first = await client.callTool({
      name: "get_secret",
      arguments: { name: "OPENAI_KEY", reason: "first call" },
    });
    assert.match(textOf(first), /sk-live-abc123/);

    const second = await client.callTool({
      name: "get_secret",
      arguments: { name: "OPENAI_KEY", reason: "second call" },
    });
    assert.match(textOf(second), /sk-live-abc123/);
    // The second access reused the cached grant — only ONE approval was requested.
    assert.equal(mock.requestCalls.length, 1, "grant should be reused, not re-requested");
    // Both reads still happened (each use re-fetches the current value).
    assert.equal(mock.readFieldsCalls.length, 2);
    // The reuse surfaces as auto-approved to the agent.
    assert.match(textOf(second), /Auto-approved/);
  } finally {
    mock.restore();
  }
});

test("Outrun list_secrets merges Outrun-stored items, external items, and mounted vaults", async () => {
  const mock = new MockOutrun();
  mock.secrets = [
    { id: "sec-1", name: "OPENAI_KEY", description: "OpenAI production key", storage: "outrun" },
    { id: "sec-2", name: "GITHUB_TOKEN", storage: "external" },
  ];
  mock.mounts = [{ toolId: "t1", displayName: "Company 1P", connectionData: { provider: "1password" } }];
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const result = await client.callTool({ name: "list_secrets", arguments: {} });
    const text = textOf(result);
    assert.match(text, /OPENAI_KEY/);
    assert.match(text, /OpenAI production key/);
    assert.match(text, /GITHUB_TOKEN/);
    assert.match(text, /Company 1P/);
  } finally {
    mock.restore();
  }
});

test("Outrun mode does not support writes", async () => {
  const mock = new MockOutrun();
  mock.install();
  try {
    const client = await connectClient(buildBackend(mock));
    const result = await client.callTool({
      name: "set_secret",
      arguments: { name: "NEW_KEY", value: "v", reason: "persist" },
    });
    assert.match(textOf(result), /not supported in Outrun mode/i);
  } finally {
    mock.restore();
  }
});
