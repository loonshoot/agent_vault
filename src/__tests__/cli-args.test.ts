import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../cli-args.js";

test("parseCliArgs: no flags returns empty options (stdio stays default)", () => {
  assert.deepEqual(parseCliArgs([]), {});
});

test("parseCliArgs: --http alone selects HTTP transport", () => {
  assert.deepEqual(parseCliArgs(["--http"]), { http: true });
});

test("parseCliArgs: --http --port <n> --host <h> parses all three", () => {
  assert.deepEqual(parseCliArgs(["--http", "--port", "8080", "--host", "0.0.0.0"]), {
    http: true,
    port: 8080,
    host: "0.0.0.0",
  });
});

test("parseCliArgs: ignores unrelated args", () => {
  assert.deepEqual(parseCliArgs(["--some-other-flag", "value"]), {});
});
