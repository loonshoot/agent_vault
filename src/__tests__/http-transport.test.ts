import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startHttpTransport } from "../http-transport.js";

function buildPingServer(): McpServer {
  const server = new McpServer({ name: "test-http-server", version: "0.0.0" });
  server.tool("ping", "returns pong", {}, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  return server;
}

test("startHttpTransport: serves MCP JSON-RPC requests over HTTP on the configured port", async () => {
  const port = 39601;
  let httpServer: Server | undefined;
  try {
    httpServer = await startHttpTransport(buildPingServer, { port, host: "127.0.0.1" });

    // 1. initialize handshake
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
      }),
    });
    assert.equal(initRes.status, 200);

    // 2. call the "ping" tool over the same HTTP transport
    const toolRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      }),
    });
    assert.equal(toolRes.status, 200);
    const contentType = toolRes.headers.get("content-type") || "";
    const raw = await toolRes.text();
    // Streamable HTTP responses can be plain JSON or an SSE-framed body
    // depending on negotiation; extract the JSON payload either way.
    const jsonText = contentType.includes("text/event-stream")
      ? raw.split("\n").find((l) => l.startsWith("data:"))!.slice("data:".length).trim()
      : raw;
    const body = JSON.parse(jsonText);
    assert.equal(body.result.content[0].text, "pong");
  } finally {
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
});

test("GET and DELETE on /mcp return 405 Method Not Allowed (stateless transport only supports POST here)", async () => {
  const port = 39602;
  let httpServer: Server | undefined;
  try {
    httpServer = await startHttpTransport(
      () => new McpServer({ name: "test-http-server-2", version: "0.0.0" }),
      { port, host: "127.0.0.1" }
    );
    const getRes = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
    assert.equal(getRes.status, 405);
    const delRes = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE" });
    assert.equal(delRes.status, 405);
  } finally {
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
});
