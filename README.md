# Agent Vault

Human-in-the-loop secret access for AI coding agents.

Agent Vault is an [MCP server](https://modelcontextprotocol.io) that sits between AI agents (Claude Code, Cursor, Windsurf, etc.) and your password manager. When an agent needs a secret, you get a link — tap approve on your phone, and the agent gets the value. Deny, and it doesn't.

No secrets are baked into config files. No blanket access. You approve each request in real time, from wherever you are.

```
Agent: "I need DATABASE_URL to run this migration"
  → 🔒 Approve access: https://abc123.ngrok-free.app/approve/xK9mQ2...
  → You tap the link on your phone → Approve
  → Agent gets the value → continues working
```

## Why this exists

AI coding agents are increasingly capable — they can run migrations, deploy services, hit APIs. But giving them blanket access to your secrets is a bad idea, and copy-pasting credentials into chat is worse.

Agent Vault gives you a middle ground: agents can *request* secrets programmatically, and you approve or deny each request from your phone with a single tap. It works with any MCP-compatible agent and any password manager (currently supports 1Password and env files, with a simple interface to add more).

## How it works

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  AI Agent    │────▶│   Agent Vault    │────▶│  1Password   │
│ (Claude Code,│ MCP │                  │ SDK │  .env file   │
│  Cursor, etc)│◀────│  ┌────────────┐  │◀────│  (more soon) │
└─────────────┘     │  │ Approval   │  │     └──────────────┘
                    │  │ Server     │──│──ngrok──▶ Your Phone
                    │  └────────────┘  │
                    │  ┌────────────┐  │
                    │  │ Audit Log  │  │
                    │  └────────────┘  │
                    └──────────────────┘
```

1. The agent calls `get_secret` with a name and a reason
2. Agent Vault creates a unique approval URL and opens it via ngrok
3. The URL appears in your terminal/chat — tap it on your phone
4. You see what's being requested and why, then tap **Approve** or **Deny**
5. The agent receives the secret value (or a denial) and continues
6. Everything is logged to a local SQLite audit trail

The agent **blocks** until you respond. It can't proceed without your decision.

## Quick start

### Prerequisites

- Node.js 18+
- An [ngrok account](https://ngrok.com) (free tier works fine) — you need an auth token

### Install

```bash
# Global install (recommended)
npm install -g agent-vault

# Or run directly with npx — no install needed
npx agent-vault
```

For 1Password support, also install the SDK:

```bash
npm install -g @1password/sdk
```

### Add to Claude Code

Add to your MCP configuration (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["agent-vault"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "OP_SERVICE_ACCOUNT_TOKEN": "your_1password_token"
      }
    }
  }
}
```

That's it. Every project on your machine can use it — no cloning, no per-project install.

### Add to Cursor / other MCP clients

Agent Vault uses stdio transport. Point your client at `npx agent-vault` with the environment variables above.

## Usage examples

### 1. Local development — your own machine

The simplest setup. Install once, use in every project.

```bash
# One-time global install
npm install -g agent-vault
```

Add to your Claude Code config (`~/.claude/claude_code_config.json`) — also one-time:

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["agent-vault"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "OP_SERVICE_ACCOUNT_TOKEN": "your_1password_token"
      }
    }
  }
}
```

Then in any project, create an `agent-vault.config.json` to define what vaults are available:

```json
{
  "vaults": {
    "dev": {
      "type": "1password",
      "serviceAccountToken": "env:OP_SERVICE_ACCOUNT_TOKEN",
      "ttl": 15,
      "ttlScope": "vault"
    }
  },
  "ngrokAuthToken": "env:NGROK_AUTHTOKEN"
}
```

Or for a simple env file setup, create `.env.secrets` in the project and point to it:

```json
{
  "vaults": {
    "local": { "type": "env", "file": ".env.secrets", "ttl": 15 }
  }
}
```

Now when you ask Claude Code to do something that needs credentials:

```
You:    "Connect to the database and check if the users table has the new column"
Agent:  calls list_secrets → sees DATABASE_URL is available in the "dev" vault
Agent:  calls get_secret("dev", "DATABASE_URL", "Need to connect to verify users table schema")
        → 🔒 Approve access: https://abc123.ngrok-free.app/approve/xK9mQ2...
        → You tap the link on your phone → see "DATABASE_URL" + the reason → Approve
Agent:  receives the connection string → runs the query → reports back
```

With `ttl: 15` and `ttlScope: "vault"`, after that first approval the agent can access any secret in the dev vault for 15 minutes without asking again.

### 2. Sandbox / testing — no password manager needed

Want to try Agent Vault without connecting to 1Password or any real secrets? The env file provider works as a standalone sandbox.

```bash
# Create a test secrets file
cat > .env.secrets << 'EOF'
TEST_API_KEY=test-key-12345
TEST_DATABASE_URL=postgresql://test:test@localhost:5432/testdb
EOF

# Create a minimal config
echo '{"vaults":{"test":{"type":"env","file":".env.secrets","ttl":5}}}' > agent-vault.config.json

# Run it (no ngrok needed for local testing)
npx agent-vault
```

You can test the MCP tools directly using the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector npx agent-vault
```

This opens a browser UI where you can call `list_secrets` and `get_secret` manually, see the approval URL, and test the full flow without needing an AI agent at all.

For a completely offline test (no ngrok), you can open the approval URL on your local machine at `http://localhost:9999/approve/...` — the ngrok URL just makes it reachable from your phone.

### 3. Headless / remote — Claude Code on a cloud VM or container

This is the primary use case Agent Vault was built for. You're running an agent on a remote machine and want to approve secret access from your phone.

**The key insight:** ngrok gives you a public URL automatically, so it doesn't matter that the machine has no screen. The approval link works from anywhere.

```bash
# On the remote machine — one-time install
npm install -g agent-vault
```

MCP config is the same everywhere:

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["agent-vault"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "OP_SERVICE_ACCOUNT_TOKEN": "your_1password_token"
      }
    }
  }
}
```

Then create `agent-vault.config.json` in the project to define the vault structure. For 1Password — no secrets ever touch disk:

```json
{
  "vaults": {
    "prod": {
      "type": "1password",
      "serviceAccountToken": "env:OP_SERVICE_ACCOUNT_TOKEN",
      "ttl": 0,
      "ttlScope": "secret"
    }
  },
  "ngrokAuthToken": "env:NGROK_AUTHTOKEN"
}
```

**How it plays out in practice:**

```
You're on your phone, monitoring a headless Claude Code session.

Claude Code: "I need to deploy the migration. Requesting database credentials."
  → 🔒 Approve access to "Production DB Password":
    https://e4f2.ngrok-free.app/approve/Rk3mZp9xQ2nW...

You tap the link. Your phone opens a clean dark page:

  ┌─────────────────────────────┐
  │  Secret Access Request      │
  │                             │
  │  Secret:  Production DB     │
  │  Reason:  Run migration     │
  │           0042_add_roles    │
  │  Time:    2:34 PM           │
  │                             │
  │  [  Approve  ]  [  Deny  ]  │
  └─────────────────────────────┘

You tap Approve. Claude Code gets the credential, runs the migration,
and you never had to SSH in, open a terminal, or copy-paste anything.
```

### Recommended TTL settings

| Scenario | TTL | Why |
|---|---|---|
| Quick local task | `0` (always ask) | You're right there, approvals are instant |
| Long local session | `15` | Don't interrupt flow for repeated access |
| Headless remote agent | `30` | Reduce phone tapping during extended runs |
| CI/CD pipeline | `60` | Approve once at the start, let it finish |
| Production / sensitive | `0` (always ask) | Every access should be deliberate |

## Configuration

Agent Vault uses a **config file** for structure (committable to your repo) and **environment variables** for secrets (tokens, auth). This lets teams share vault configuration while each person sets their own credentials.

### Config file

Create `agent-vault.config.json` in your project root:

```jsonc
{
  "vaults": {
    "dev": {
      "type": "1password",
      "serviceAccountToken": "env:OP_DEV_TOKEN",
      "vaultIds": ["abc123"],
      "ttl": 15
    },
    "prod": {
      "type": "1password",
      "serviceAccountToken": "env:OP_PROD_TOKEN",
      "vaultIds": ["def456"],
      "ttl": 0
    },
    "local": {
      "type": "env",
      "file": ".env.secrets",
      "ttl": 30
    }
  },
  "ngrokAuthToken": "env:NGROK_AUTHTOKEN",
  "port": 9999
}
```

**Commit this file to your repo.** It contains no secrets — just structure. The `"env:VAR_NAME"` syntax tells Agent Vault to read the actual value from an environment variable at runtime.

Then each team member just sets their own `.env` or shell exports:

```bash
# .env (gitignored) or shell exports
OP_DEV_TOKEN=ops_your_dev_service_account_token
OP_PROD_TOKEN=ops_your_prod_service_account_token
NGROK_AUTHTOKEN=your_ngrok_token
```

Agent Vault searches for the config file in this order:
1. Path specified by `AGENT_VAULT_CONFIG` env var
2. `agent-vault.config.json` in the current working directory
3. `~/.agent-vault.config.json` in your home directory

### Vault configuration

Each vault entry supports:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"env"` or `"1password"` | yes | Provider type |
| `ttl` | number | no | Approval window in minutes (default: `0` = always ask) |
| `ttlScope` | `"secret"` or `"vault"` | no | What the approval window covers (default: `"secret"`) |
| `file` | string | env only | Path to `.env`-style secrets file (relative to config file) |
| `serviceAccountToken` | string | 1password only | Service account token or `"env:VAR_NAME"` reference |
| `vaultIds` | string[] | no | 1Password vault IDs to expose (default: all accessible) |

### Top-level configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `ngrokAuthToken` | string | — | ngrok auth token or `"env:VAR_NAME"` reference |
| `port` | number | `9999` | Local port for the approval HTTP server |

### Legacy env var mode

If no config file is found, Agent Vault falls back to single-vault configuration via environment variables. This is for quick testing or simple setups:

| Variable | Default | Description |
|---|---|---|
| `AGENT_VAULT_PROVIDER` | `env` | Provider: `env` or `1password` |
| `AGENT_VAULT_ENV_FILE` | `.env.secrets` | Path to secrets file (env provider) |
| `AGENT_VAULT_PORT` | `9999` | Local port for approval server |
| `AGENT_VAULT_TTL_MINUTES` | `0` | Auto-approve window in minutes |
| `AGENT_VAULT_DB` | `agent-vault.db` | SQLite database path |
| `NGROK_AUTHTOKEN` | — | ngrok auth token |
| `OP_SERVICE_ACCOUNT_TOKEN` | — | 1Password service account token |
| `AGENT_VAULT_1P_VAULTS` | — | Comma-separated vault IDs |

## MCP tools

Agent Vault exposes two tools to the agent:

### `list_secrets`

Lists available secret names across all configured vaults. Never reveals values — just tells the agent what's available and which vault it's in.

**Parameters:** none

**Example response:**
```
[dev]
  - DATABASE_URL
  - API_KEY

[prod]
  - DATABASE_URL (production)
  - STRIPE_SECRET_KEY (production)

[local]
  - TEST_TOKEN
```

### `get_secret`

Requests access to a single secret. Use `get_secrets` (below) when you need multiple — it's a better experience for the approver.

**Parameters:**
| Name | Type | Description |
|---|---|---|
| `vault` | string | The vault name (as defined in your config) |
| `name` | string | The name or ID of the secret |
| `reason` | string | Why the agent needs this secret (shown to the approver) |

The tool call **blocks** until you approve or deny. The agent cannot proceed without your decision.

**On approval:** returns the secret value as plain text.

**On denial:** returns a denial message.

### `get_secrets`

Requests access to multiple secrets in a single approval. The approver sees the full list and approves or denies all at once — much better than getting pinged once per secret.

**Parameters:**
| Name | Type | Description |
|---|---|---|
| `vault` | string | The vault name |
| `names` | string[] | List of secret names/IDs to access |
| `reason` | string | Why the agent needs these secrets |

**Example:** an agent needs both `DATABASE_URL` and `DATABASE_PASSWORD` to run a migration. Instead of two separate approval links, you get one that says "2 secrets: DATABASE_URL, DATABASE_PASSWORD" — tap approve once.

If some secrets already have active approval windows, only the ones that need approval are shown in the request. If all are already permitted, the call returns immediately with no approval needed.

## Providers

### env file (default)

Reads secrets from a `.env`-style file. Supports comments, quoted values, and standard `KEY=value` format. Good for testing or simple setups.

```bash
AGENT_VAULT_PROVIDER=env
AGENT_VAULT_ENV_FILE=/path/to/.env.secrets
```

Example `.env.secrets`:
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb

# API keys
STRIPE_SECRET_KEY="sk_live_..."
OPENAI_API_KEY='sk-...'
```

### 1Password

Uses a [1Password service account](https://developer.1password.com/docs/service-accounts) for production vault access. Secrets are referenced using `op://` URIs.

```bash
AGENT_VAULT_PROVIDER=1password
OP_SERVICE_ACCOUNT_TOKEN=your_service_account_token

# Optional: restrict to specific vaults
AGENT_VAULT_1P_VAULTS=vault_id_1,vault_id_2
```

Requires the 1Password SDK as an additional dependency:

```bash
npm install @1password/sdk
```

When listing secrets, items appear with their vault ID as the group. When requesting a secret, use the `op://vault/item/field` format.

## Approval windows (TTL)

By default, every secret access requires explicit approval (`ttl: 0`). For long sessions where an agent needs repeated access, you can configure approval windows — a permission cache that lets the agent re-fetch secrets without re-asking.

**No secrets are stored.** The approval window just permits the agent to fetch again from the provider. When the window expires, it has to ask again.

### Per-secret scope (default)

```json
{
  "type": "1password",
  "ttl": 15,
  "ttlScope": "secret"
}
```

After you approve `DATABASE_URL`, the agent can re-fetch `DATABASE_URL` for 15 minutes without asking. But if it needs `API_KEY`, that's a separate approval.

### Per-vault scope

```json
{
  "type": "1password",
  "ttl": 30,
  "ttlScope": "vault"
}
```

After you approve **any** secret in this vault, the agent can access **all** secrets in this vault for 30 minutes. One tap unlocks the whole vault for the window. Good for dev environments where you trust the vault contents and don't want to be pinged repeatedly.

### Combining scopes across vaults

A common pattern: loose permissions for dev, strict for prod.

```json
{
  "vaults": {
    "dev": {
      "type": "1password",
      "serviceAccountToken": "env:OP_DEV_TOKEN",
      "ttl": 30,
      "ttlScope": "vault"
    },
    "prod": {
      "type": "1password",
      "serviceAccountToken": "env:OP_PROD_TOKEN",
      "ttl": 0,
      "ttlScope": "secret"
    }
  }
}
```

Dev vault: approve once, agent has free access for 30 minutes. Prod vault: every single secret, every single time.

## Audit log

Every secret access is recorded in a local SQLite database (`agent-vault.db` by default):

| Column | Description |
|---|---|
| `timestamp` | When the request was made |
| `secret_name` | Which secret was requested |
| `reason` | Why the agent said it needed it |
| `action` | `approved`, `denied`, or `auto_approved` |
| `ttl_expires_at` | When the auto-approval window expires (if applicable) |

You can query it directly:

```bash
sqlite3 agent-vault.db "SELECT * FROM audit ORDER BY timestamp DESC LIMIT 20"
```

## Observability webhooks

Agent Vault can forward every access event to external logging, analytics, or SIEM endpoints. Events fire asynchronously and never block the agent — if a webhook fails, it's logged to stderr and the agent continues.

### Configuration

Add a `webhooks` array to your config:

```json
{
  "vaults": { ... },
  "webhooks": [
    {
      "url": "https://logs.example.com/api/events",
      "authorization": "env:LOGGING_API_KEY",
      "events": "all"
    },
    {
      "url": "https://your-datadog-intake.example.com/v1/input",
      "authorization": "env:DD_API_KEY",
      "events": ["approved", "denied"]
    }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | *required* | Endpoint to POST events to |
| `authorization` | string | — | `Authorization` header value (supports `env:` references) |
| `events` | `"all"` or array | `"all"` | Which events to send: `"approved"`, `"denied"`, `"auto_approved"` |

### Event payload

Every event is a JSON POST with this shape:

```json
{
  "event": "secret_access",
  "timestamp": "2026-04-10T14:32:01.000Z",
  "vault": "dev",
  "secrets": ["DATABASE_URL", "API_KEY"],
  "reason": "Need database credentials to run migration 0042",
  "action": "approved",
  "scope": "vault",
  "ttlExpiresAt": "2026-04-10T14:47:01.000Z"
}
```

| Field | Description |
|---|---|
| `event` | Always `"secret_access"` |
| `timestamp` | ISO 8601 when the decision was made |
| `vault` | Which vault was accessed |
| `secrets` | Array of secret names in the request |
| `reason` | The agent's stated reason |
| `action` | `"approved"`, `"denied"`, or `"auto_approved"` |
| `scope` | `"secret"` or `"vault"` — what the approval covered |
| `ttlExpiresAt` | When the approval window expires (null if no TTL) |

### Example integrations

**Datadog Logs:**
```json
{
  "url": "https://http-intake.logs.datadoghq.com/api/v2/logs",
  "authorization": "env:DD_API_KEY",
  "events": "all"
}
```

**Splunk HEC:**
```json
{
  "url": "https://your-splunk:8088/services/collector/event",
  "authorization": "env:SPLUNK_HEC_TOKEN",
  "events": "all"
}
```

**Custom webhook (Slack, Discord, etc.):**
```json
{
  "url": "https://hooks.slack.com/services/T00/B00/xxx",
  "events": ["denied"]
}
```

Sending only `"denied"` events to Slack is a useful pattern — you get alerted when an agent is denied access, which may indicate something unexpected is happening.

## Security considerations

- **Secrets are transmitted over HTTPS** via the ngrok tunnel. The approval page never displays the secret value — only the name and reason.
- **Approval URLs are single-use** with random 16-character IDs. Once approved or denied, the URL is invalidated.
- **ngrok tunnels are ephemeral** — they only exist while Agent Vault is running. No persistent public endpoint.
- **The agent receives the secret in the MCP tool response.** What the agent does with it after that is outside Agent Vault's control — this is the same trust boundary as typing a secret into your terminal.
- **Service account tokens** (ngrok, 1Password) should be treated as sensitive. Don't commit them to version control. The `.gitignore` already excludes `.env.secrets`.
- **The approval server has no authentication** beyond the unguessable URL. Anyone with the link can approve or deny. For high-security environments, consider running ngrok with IP restrictions or using a VPN.

## Adding a new provider

Implement the `SecretProvider` interface:

```typescript
import type { SecretEntry, SecretProvider } from "./providers/provider.js";

export class MyProvider implements SecretProvider {
  readonly name = "my-provider";

  async listSecrets(): Promise<SecretEntry[]> {
    // Return secret names/IDs — never values
    return [
      { id: "secret-1", name: "DATABASE_URL", group: "production" }
    ];
  }

  async getSecret(id: string): Promise<string> {
    // Fetch and return the actual secret value
    return "the-secret-value";
  }
}
```

Then add it to the provider switch in `src/index.ts`:

```typescript
case "my-provider": {
  return new MyProvider(/* config */);
}
```

The interface is intentionally minimal — three members, no lifecycle methods, no configuration schema. The goal is to make it trivial to add Bitwarden, HashiCorp Vault, AWS Secrets Manager, or anything else.

## Project structure

```
src/
├── index.ts                  Entry point — wires provider, approval server, and MCP server
├── server.ts                 MCP server with list_secrets and get_secret tools
├── approval.ts               Express HTTP server + ngrok tunnel for approve/deny pages
├── audit.ts                  SQLite audit log with TTL-based auto-approval checks
└── providers/
    ├── provider.ts           SecretProvider interface
    ├── env-provider.ts       .env file provider
    ├── onepassword-provider.ts  1Password service account provider
    └── index.ts              Re-exports
```

## Setup prompts

Copy-paste these prompts into your AI agent to have it set up Agent Vault for you.

### Local setup with env file

```
Set up agent-vault so you can request secrets from me with my approval instead
of me pasting them into chat. It's an npm package — no cloning needed.

Docs: https://github.com/loonshoot/agent_vault

1. Add agent-vault to my Claude Code MCP config (~/.claude/claude_code_config.json):
   {
     "mcpServers": {
       "agent-vault": {
         "command": "npx",
         "args": ["agent-vault"],
         "env": {
           "NGROK_AUTHTOKEN": "<I will provide>"
         }
       }
     }
   }
2. Create an `agent-vault.config.json` in THIS project directory with:
   {
     "vaults": {
       "local": {
         "type": "env",
         "file": ".env.secrets",
         "ttl": 15
       }
     }
   }
3. Create a `.env.secrets` file in this project with placeholder values for:
   - DATABASE_URL
   - API_KEY
4. Show me what you configured so I can fill in the real values and my NGROK_AUTHTOKEN
```

### Setup with 1Password

```
Set up agent-vault so you can request secrets from my 1Password with my approval.
When you need a credential, you call a tool, I get a link on my phone, and I tap
approve or deny. It's an npm package — no cloning needed.

Docs: https://github.com/loonshoot/agent_vault

1. Add agent-vault to my Claude Code MCP config (~/.claude/claude_code_config.json):
   {
     "mcpServers": {
       "agent-vault": {
         "command": "npx",
         "args": ["agent-vault"],
         "env": {
           "OP_SERVICE_ACCOUNT_TOKEN": "<I will provide>",
           "NGROK_AUTHTOKEN": "<I will provide>"
         }
       }
     }
   }
2. Create an `agent-vault.config.json` in THIS project directory with:
   {
     "vaults": {
       "dev": {
         "type": "1password",
         "serviceAccountToken": "env:OP_SERVICE_ACCOUNT_TOKEN",
         "ttl": 15,
         "ttlScope": "vault"
       }
     },
     "ngrokAuthToken": "env:NGROK_AUTHTOKEN"
   }
3. Show me the final config and tell me which env vars I need to set:
   - OP_SERVICE_ACCOUNT_TOKEN: 1Password service account token (how to create one)
   - NGROK_AUTHTOKEN: free ngrok.com auth token
4. After I've set my tokens, test by calling list_secrets, then get_secret on
   one of them so I can test the approval flow from my phone.

Walk me through each step. Wait for my confirmation before moving on.
```

### Remote / headless setup

```
Set up agent-vault so I can approve secret access from my phone while you work
on this remote machine. It's an npm package — no cloning needed.

Docs: https://github.com/loonshoot/agent_vault

1. Run `npm install -g agent-vault` on this machine
2. Add agent-vault to your MCP config:
   {
     "mcpServers": {
       "agent-vault": {
         "command": "npx",
         "args": ["agent-vault"],
         "env": {
           "NGROK_AUTHTOKEN": "<I will provide>"
         }
       }
     }
   }
3. Create an `agent-vault.config.json` in this project with:
   {
     "vaults": {
       "secrets": {
         "type": "env",
         "file": ".env.secrets",
         "ttl": 30
       }
     }
   }
4. Create a `.env.secrets` with placeholder values for:
   - DATABASE_URL
   - DEPLOY_KEY
   - API_SECRET
5. Show me the config. When I give you the NGROK_AUTHTOKEN and secret values,
   update them. After that, whenever you need a secret, use the get_secret tool —
   I'll get a link on my phone to approve it.
```

Customize the vault names and secret keys in each prompt to match your project.

## Agent instructions

Add the following to your project's `CLAUDE.md` (or equivalent agent instructions file) so your agent knows how to use Agent Vault automatically:

```markdown
## Secrets

This project uses agent-vault for secret access. NEVER ask the user to paste
secrets, credentials, API keys, or tokens into chat.

When you need a secret:
1. Call `list_secrets` to see what's available across configured vaults
2. Call `get_secret` or `get_secrets` with the vault name, secret name(s),
   and a clear reason why you need them
3. Wait for the user to approve via the link — do not proceed without approval
4. Use the returned value directly — do not log, echo, or store it anywhere

Rules:
- Always use `get_secrets` (batch) when you need more than one secret at a time —
  it sends a single approval request instead of one per secret
- Always provide a specific, honest reason (e.g. "Need DATABASE_URL to run the
  pending migration" not "need credentials")
- If access is denied, do not re-request the same secret — ask the user what
  they'd like you to do instead
- Never write secrets to files, environment variables, logs, or commit history
- If a command needs a secret as an argument, prefer environment variable
  injection (e.g. `DATABASE_URL=<value> npm run migrate`) over passing it
  as a CLI flag where it would appear in process lists
```

For teams, commit this to your repo so every agent session follows the same rules.

## Roadmap

- [ ] Bitwarden Secrets Manager provider
- [ ] HashiCorp Vault provider
- [ ] AWS Secrets Manager provider
- [ ] Secret classification levels (auto-approve low-risk, always prompt for high-risk)
- [ ] Multiple approval channels (Telegram, Slack, ntfy.sh) as alternatives to the link
- [ ] Bulk approval ("approve all secrets for this session")
- [ ] Web dashboard for audit log

## License

MIT
