export interface CliArgs {
  http?: boolean;
  port?: number;
  host?: string;
}

/**
 * Minimal CLI flag parser — no extra dependency needed for three flags.
 * --http forces the HTTP MCP transport (default remains stdio).
 * --port / --host override the HTTP transport's bind port/host.
 * These take precedence over AGENT_VAULT_TRANSPORT / AGENT_VAULT_HTTP_PORT /
 * AGENT_VAULT_HTTP_HOST env vars and the config file's transport/httpPort/httpHost.
 *
 * Kept in its own module (rather than inline in index.ts) so it can be unit
 * tested without executing index.ts's top-level `main()` call.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") {
      args.http = true;
    } else if (arg === "--port") {
      args.port = Number(argv[++i]);
    } else if (arg === "--host") {
      args.host = argv[++i];
    }
  }
  return args;
}
