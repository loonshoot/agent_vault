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

### Install and run

```bash
git clone https://github.com/yourname/agent-vault.git
cd agent-vault
npm install
npm run build

# Create a secrets file for testing
cp .env.secrets.example .env.secrets
# Edit .env.secrets with your values

# Set your ngrok auth token
export NGROK_AUTHTOKEN=your_token_here

# Run
npm start
```

### Add to Claude Code

Add to your MCP configuration (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "node",
      "args": ["/absolute/path/to/agent-vault/dist/index.js"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "AGENT_VAULT_PROVIDER": "env",
        "AGENT_VAULT_ENV_FILE": "/absolute/path/to/.env.secrets"
      }
    }
  }
}
```

### Add to Cursor / other MCP clients

Agent Vault uses stdio transport, which is the standard for MCP servers. Add it the same way you'd add any MCP server to your client — point it at `node dist/index.js` with the environment variables below.

## Usage examples

### 1. Local development — your own machine

The simplest setup. You're running Claude Code (or another agent) locally and want it to access secrets with your approval.

```bash
# One-time setup
cd agent-vault
cp .env.secrets.example .env.secrets
```

Edit `.env.secrets` with the secrets your projects actually need:

```bash
# .env.secrets
DATABASE_URL=postgresql://admin:s3cret@localhost:5432/myapp
STRIPE_SECRET_KEY=sk_live_abc123
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

Add to your Claude Code config (`~/.claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "node",
      "args": ["/Users/you/agent-vault/dist/index.js"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "AGENT_VAULT_PROVIDER": "env",
        "AGENT_VAULT_ENV_FILE": "/Users/you/agent-vault/.env.secrets",
        "AGENT_VAULT_TTL_MINUTES": "15"
      }
    }
  }
}
```

Now when you ask Claude Code to do something that needs credentials:

```
You:    "Connect to the database and check if the users table has the new column"
Agent:  calls list_secrets → sees DATABASE_URL is available
Agent:  calls get_secret("DATABASE_URL", "Need to connect to verify users table schema")
        → 🔒 Approve access: https://abc123.ngrok-free.app/approve/xK9mQ2...
        → You tap the link on your phone → see "DATABASE_URL" + the reason → Approve
Agent:  receives the connection string → runs the query → reports back
```

With `AGENT_VAULT_TTL_MINUTES=15`, if the agent needs `DATABASE_URL` again in the next 15 minutes, it auto-approves without bothering you.

### 2. Sandbox / testing — no password manager needed

Want to try Agent Vault without connecting to 1Password or any real secrets? The env file provider works as a standalone sandbox. This is great for:

- Testing the approval flow end-to-end
- Demos
- CI/CD environments with injected secrets
- Situations where you don't use a password manager

```bash
cd agent-vault
npm install && npm run build

# Create a test secrets file with dummy values
cat > .env.secrets << 'EOF'
# Sandbox secrets for testing
TEST_API_KEY=test-key-12345
TEST_DATABASE_URL=postgresql://test:test@localhost:5432/testdb
TEST_WEBHOOK_SECRET=whsec_test_xxxxx
EOF

# Run it — that's it
export NGROK_AUTHTOKEN=your_ngrok_token
npm start
```

You can test the MCP tools directly using the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a browser UI where you can call `list_secrets` and `get_secret` manually, see the approval URL, and test the full flow without needing an AI agent at all.

For a completely offline test (no ngrok), you can open the approval URL on your local machine at `http://localhost:9999/approve/...` — the ngrok URL just makes it reachable from your phone.

### 3. Headless / remote — Claude Code on a cloud VM or container

This is the primary use case Agent Vault was built for. You're running an agent on a remote machine (EC2, a Docker container, a CI runner, a cloud dev environment) and you want to approve secret access from your phone without SSH-ing in.

**The key insight:** ngrok gives you a public URL automatically, so it doesn't matter that the machine has no screen or that you can't access `localhost`. The approval link works from anywhere.

#### Option A: env file with secrets baked into the environment

Best for containers and CI where secrets are injected via environment variables or mounted files.

```dockerfile
# Dockerfile example
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "dist/index.js"]
```

```bash
# Run the container with secrets mounted
docker run -d \
  -e NGROK_AUTHTOKEN=your_ngrok_token \
  -e AGENT_VAULT_PROVIDER=env \
  -e AGENT_VAULT_ENV_FILE=/secrets/.env.secrets \
  -e AGENT_VAULT_TTL_MINUTES=30 \
  -v /path/to/secrets:/secrets:ro \
  agent-vault
```

Add to Claude Code's remote MCP config:

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "node",
      "args": ["/app/dist/index.js"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "AGENT_VAULT_PROVIDER": "env",
        "AGENT_VAULT_ENV_FILE": "/secrets/.env.secrets",
        "AGENT_VAULT_TTL_MINUTES": "30"
      }
    }
  }
}
```

#### Option B: 1Password service account — no secrets on disk

Best for production and multi-vault setups. The remote machine never stores secrets — it pulls them from 1Password at request time, and only after you approve.

```bash
# On the remote machine
cd agent-vault
npm install && npm install @1password/sdk && npm run build
```

Add to Claude Code's MCP config:

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "node",
      "args": ["/home/user/agent-vault/dist/index.js"],
      "env": {
        "NGROK_AUTHTOKEN": "your_ngrok_token",
        "AGENT_VAULT_PROVIDER": "1password",
        "OP_SERVICE_ACCOUNT_TOKEN": "your_1p_service_account_token",
        "AGENT_VAULT_1P_VAULTS": "dev-vault-id",
        "AGENT_VAULT_TTL_MINUTES": "30"
      }
    }
  }
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

#### Option C: multiple agents sharing one vault

If you're running several agents across different projects or machines, they can all point to the same Agent Vault instance (or each run their own). Each request still requires individual approval.

For shared access, run Agent Vault as a long-lived process on a server and configure each agent's MCP to connect to it. For isolated access, bundle Agent Vault into each agent's environment with its own config.

### Recommended TTL settings

| Scenario | TTL | Why |
|---|---|---|
| Quick local task | `0` (always ask) | You're right there, approvals are instant |
| Long local session | `15` | Don't interrupt flow for repeated access |
| Headless remote agent | `30` | Reduce phone tapping during extended runs |
| CI/CD pipeline | `60` | Approve once at the start, let it finish |
| Production / sensitive | `0` (always ask) | Every access should be deliberate |

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `AGENT_VAULT_PROVIDER` | `env` | Secret provider to use: `env` or `1password` |
| `AGENT_VAULT_ENV_FILE` | `.env.secrets` | Path to secrets file (when using `env` provider) |
| `AGENT_VAULT_PORT` | `9999` | Local port for the approval HTTP server |
| `AGENT_VAULT_TTL_MINUTES` | `0` | Auto-approve window after first approval (see [TTL auto-approval](#ttl-auto-approval)) |
| `AGENT_VAULT_DB` | `agent-vault.db` | Path to SQLite database for audit log |
| `NGROK_AUTHTOKEN` | *required* | Your ngrok auth token |
| `OP_SERVICE_ACCOUNT_TOKEN` | — | 1Password service account token (when using `1password` provider) |
| `AGENT_VAULT_1P_VAULTS` | — | Comma-separated vault IDs to expose (1Password only; defaults to all accessible) |

## MCP tools

Agent Vault exposes two tools to the agent:

### `list_secrets`

Lists available secret names and groups. Never reveals values — just tells the agent what's available so it can request the right thing.

**Parameters:** none

**Example response:**
```
Available secrets:
- DATABASE_URL
- API_KEY
- AWS_SECRET_ACCESS_KEY
```

### `get_secret`

Requests access to a specific secret. The agent must provide a reason, which is displayed on the approval page so you know *why* it's asking.

**Parameters:**
| Name | Type | Description |
|---|---|---|
| `name` | string | The name or ID of the secret |
| `reason` | string | Why the agent needs this secret (shown to the approver) |

The tool call **blocks** until you approve or deny. The agent cannot proceed without your decision.

**On approval:** returns the secret value as plain text.

**On denial:** returns `Access to "SECRET_NAME" was DENIED by the user.`

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

## TTL auto-approval

By default, every secret access requires explicit approval (`AGENT_VAULT_TTL_MINUTES=0`). For long coding sessions where an agent may need the same secret multiple times, you can set an auto-approval window:

```bash
AGENT_VAULT_TTL_MINUTES=30
```

After you approve access to a secret, subsequent requests for that **same secret** are automatically approved for 30 minutes. Each secret has its own independent TTL. A different secret still requires explicit approval.

This is useful when an agent is iterating on something that requires repeated database access or API calls — you approve once and let it work for a while, rather than tapping approve every 30 seconds.

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
