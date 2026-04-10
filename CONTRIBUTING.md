# Contributing to Agent Vault

Thanks for your interest in contributing. Here's what you need to know.

## Development setup

```bash
git clone https://github.com/yourname/agent-vault.git
cd agent-vault
npm install
```

You'll need an ngrok auth token to test the approval flow. Sign up at [ngrok.com](https://ngrok.com) (free tier is fine).

```bash
export NGROK_AUTHTOKEN=your_token
cp .env.secrets.example .env.secrets
npm run dev
```

`npm run dev` runs the server with `tsx` for hot-reload during development.

## Project layout

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — resolves config, starts the approval server and MCP server |
| `src/server.ts` | MCP tool definitions (`list_secrets`, `get_secret`) |
| `src/approval.ts` | Express server + ngrok tunnel for the approve/deny web pages |
| `src/audit.ts` | SQLite audit log and TTL auto-approval logic |
| `src/providers/provider.ts` | `SecretProvider` interface |
| `src/providers/env-provider.ts` | `.env` file provider |
| `src/providers/onepassword-provider.ts` | 1Password service account provider |

## Adding a new provider

This is the most useful kind of contribution. To add support for a new secret manager:

1. Create `src/providers/your-provider.ts` implementing `SecretProvider`
2. Add the provider to the switch in `src/index.ts`
3. Export it from `src/providers/index.ts`
4. Document the required env vars in the README
5. If it requires an SDK, make it an optional dependency with a dynamic import (see the 1Password provider for an example)

The `SecretProvider` interface is intentionally small:

```typescript
interface SecretProvider {
  readonly name: string;
  listSecrets(): Promise<SecretEntry[]>;
  getSecret(id: string): Promise<string>;
}
```

`listSecrets` should return names/IDs only — never secret values. `getSecret` fetches the actual value when the user has approved access.

## Code style

- TypeScript, strict mode
- ES modules (`"type": "module"`)
- No classes where a function will do, but classes are fine for stateful components
- No unnecessary abstractions — keep it simple

## Testing

Currently there are no automated tests. If you're adding a provider, test it manually:

1. Start the server with your provider configured
2. Connect an MCP client (or use the MCP inspector)
3. Call `list_secrets` and verify the output
4. Call `get_secret` and verify the approval flow works end-to-end

Automated tests are welcome — especially for the approval flow and audit log.

## Pull requests

- Keep PRs focused. One provider per PR, one feature per PR.
- Update the README if you're adding user-facing functionality.
- Make sure `npm run build` succeeds with no errors.

## Issues

If you find a bug or have a feature request, open an issue. For provider requests, include a link to the secret manager's API documentation so we can assess feasibility.
