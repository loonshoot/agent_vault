import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpTransportOptions {
  port: number;
  /** Bind host (default: 127.0.0.1). Use "0.0.0.0" deliberately for remote access, e.g. behind a reverse proxy/VPN. */
  host?: string;
}

/**
 * Start MCP on a persistent HTTP (Streamable HTTP) transport instead of
 * stdio. This lets ONE long-lived process serve MULTIPLE remote clients over
 * the network, all sharing the same `pending` approval map, the same TTL
 * cache, and the same audit log instance — instead of each client spawning
 * its own fragmented stdio subprocess (each with its own isolated state) via
 * `npx agent-vault`.
 *
 * `createServer` is a FACTORY, not a shared instance. The underlying
 * `McpServer`/`Protocol` object only supports being `connect()`-ed to a
 * single transport for its lifetime (calling `connect()` twice throws —
 * "use a separate Protocol instance per connection", per the SDK), which is
 * exactly what the SDK's own stateless HTTP example does: a fresh
 * `McpServer` + fresh `StreamableHTTPServerTransport` per request
 * (dist/examples/server/simpleStatelessStreamableHttp.js). Since our tool
 * handlers close over the *shared* `vaults`/`approval`/`audit`/`webhooks`
 * passed into `createMcpServer(config)`, creating a cheap, ephemeral
 * `McpServer` wrapper per request does not fragment any of that shared
 * state — only the protocol glue is per-request, not the approval map, TTL
 * cache, or audit log.
 *
 * stdio remains the default transport for existing single-user local usage
 * (npx agent-vault spawned per Claude Code config); this is opt-in via
 * --http / AGENT_VAULT_TRANSPORT=http / config.transport.
 */
export async function startHttpTransport(
  createServer: () => McpServer,
  options: HttpTransportOptions
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: import("express").Request, res: import("express").Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, host, () => {
      console.error(`MCP HTTP transport listening on http://${host}:${options.port}/mcp`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
