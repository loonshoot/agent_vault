import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";

function writeConfig(contents: object): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-vault-cfg-"));
  const path = join(dir, "agent-vault.config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

/** loadConfig reads AGENT_VAULT_CONFIG; set/reset it around each case. */
function withConfig<T>(contents: object, fn: () => T): T {
  const prev = process.env.AGENT_VAULT_CONFIG;
  process.env.AGENT_VAULT_CONFIG = writeConfig(contents);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_VAULT_CONFIG;
    else process.env.AGENT_VAULT_CONFIG = prev;
  }
}

test("parses an outrun block with env: apiKey indirection", () => {
  process.env.OUTRUN_API_KEY = "resolved-secret-key";
  try {
    const config = withConfig(
      {
        outrun: {
          url: "https://gateway.outrun.test",
          apiKey: "env:OUTRUN_API_KEY",
          workspaceId: "ws-42",
          pollIntervalMs: 1500,
          timeoutMs: 60000,
          defaultTtlMinutes: 30,
        },
      },
      () => loadConfig()
    );
    assert.ok(config.outrun);
    assert.equal(config.outrun!.url, "https://gateway.outrun.test");
    assert.equal(config.outrun!.apiKey, "resolved-secret-key"); // env ref resolved
    assert.equal(config.outrun!.workspaceId, "ws-42");
    assert.equal(config.outrun!.pollIntervalMs, 1500);
    assert.equal(config.outrun!.timeoutMs, 60000);
    assert.equal(config.outrun!.defaultTtlMinutes, 30);
  } finally {
    delete process.env.OUTRUN_API_KEY;
  }
});

test("no outrun block → pure local config (config.outrun is undefined)", () => {
  const config = withConfig(
    {
      vaults: {
        local: { type: "env", file: ".env.secrets", ttl: 15 },
      },
    },
    () => loadConfig()
  );
  assert.equal(config.outrun, undefined);
  assert.ok(config.vaults.local);
  assert.equal(config.vaults.local.type, "env");
});

test("outrun mode allows a config with no vaults block at all (pure full-remote)", () => {
  process.env.OUTRUN_API_KEY = "k";
  try {
    const config = withConfig(
      { outrun: { url: "https://g.test", apiKey: "env:OUTRUN_API_KEY", workspaceId: "ws-1" } },
      () => loadConfig()
    );
    assert.ok(config.outrun);
    assert.deepEqual(config.vaults, {}); // no vaults is fine in Outrun mode
  } finally {
    delete process.env.OUTRUN_API_KEY;
  }
});
