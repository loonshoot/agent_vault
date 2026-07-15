import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFetchArgs } from "../fetch-cli.js";

test("parseFetchArgs: no flags returns empty options", () => {
  assert.deepEqual(parseFetchArgs([]), {});
});

test("parseFetchArgs: --secret and --reason parse", () => {
  assert.deepEqual(parseFetchArgs(["--secret", "CLAUDE_CODE_OAUTH_TOKEN", "--reason", "boot the agent"]), {
    secret: "CLAUDE_CODE_OAUTH_TOKEN",
    reason: "boot the agent",
  });
});

test("parseFetchArgs: all flags parse", () => {
  assert.deepEqual(
    parseFetchArgs([
      "--secret", "X",
      "--reason", "Y",
      "--vault", "prod",
      "--requester-id", "worker-1",
      "--task-id", "issue-201",
      "--branch", "ai/issue-201",
    ]),
    {
      secret: "X",
      reason: "Y",
      vault: "prod",
      requesterId: "worker-1",
      taskId: "issue-201",
      branch: "ai/issue-201",
    }
  );
});

test("parseFetchArgs: ignores unrelated args", () => {
  assert.deepEqual(parseFetchArgs(["--some-other-flag", "value"]), {});
});
