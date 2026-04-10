# Agent Vault: Secure Secret Access for Agentic Development Pipelines

**A Security Whitepaper**

Version 1.0 — April 2026

---

## Status

**Agent Vault is a proof of concept.** The implementation demonstrates the architecture and workflows described in this paper, but it is not production-hardened. In particular, the approval endpoints lack authentication (Section 2.2), the audit log is a local SQLite file deletable by the agent, and provider coverage is limited to 1Password and env files. This paper describes both the current state and the target architecture — Section 8 details the work required to close the remaining gaps.

## Abstract

AI coding agents are transforming software development. Tools like Claude Code, Cursor, and Windsurf can write code, run tests, deploy services, and manage infrastructure — often in headless, sandboxed environments with minimal human oversight. But as agents gain capability, a critical security gap has emerged: how do agents access secrets?

Today, the answer is alarmingly simple. Developers either pre-load sandboxes with credentials, copy-paste secrets into chat windows, or grant agents blanket access to entire vaults. Each approach violates fundamental security principles that the industry spent decades establishing.

Agent Vault is an open-source middleware that sits between AI agents and secret management systems. It enforces human-in-the-loop approval for every secret access request, works with any MCP-compatible agent, supports multiple secret providers simultaneously, and is configurable to match an organization's risk appetite — from strict per-secret approval to time-windowed vault-level access.

This paper describes the problem, the threat model, the architecture, and the path toward secure agentic development at scale.

---

## 1. The Problem

### 1.1 The rise of agentic development

The shift from AI-assisted coding to AI-agentic coding is well underway. Developers no longer just ask for code suggestions — they delegate entire workflows. An agent might:

- Read a ticket, write the implementation, run tests, and open a pull request
- Connect to a database, inspect schema, run migrations
- Deploy to staging, verify health checks, promote to production
- Rotate API keys, update DNS records, configure CI/CD

Each of these workflows requires credentials. Database connection strings, API keys, cloud provider tokens, deployment keys, service account credentials — the same secrets that organizations store in systems like 1Password, Bitwarden, HashiCorp Vault, AWS Secrets Manager, and Google Cloud Secret Manager.

### 1.2 How secrets reach agents today

There is currently no standard, secure mechanism for agents to access secrets. In practice, developers use one of four approaches, all of which are problematic:

**Pre-loaded sandboxes.** Secrets are baked into the environment before the agent starts — as environment variables, mounted files, or injected by CI/CD. The agent has blanket access to everything from the moment it boots. There is no distinction between a secret needed for a database query and one needed for a production deployment. There is no audit trail of which secrets were actually accessed, and no mechanism to revoke access mid-session.

**Copy-pasting into chat.** The developer retrieves the secret from their password manager and pastes it into the agent's conversation. The secret is now stored in the conversation history, potentially logged by the platform, visible in session replays, and persisted in plaintext in contexts that were never designed for secret storage. This is the digital equivalent of writing a password on a sticky note — except the sticky note is automatically backed up to the cloud.

**Service accounts with full access.** The agent is configured with a service account token (e.g., a 1Password service account) that has read access to entire vaults. This eliminates the copy-paste problem but introduces a far larger one: the agent can access any secret at any time, with no approval, no audit granularity, and no way to scope access per-task or per-session. A compromised agent — or a hallucinating one — has the keys to the kingdom.

**Manual environment variable injection.** The developer sets specific environment variables before launching the agent. This is marginally better than blanket access but provides no dynamic capability — the agent cannot request a secret it wasn't preconfigured with, there is no approval workflow, and the variables persist for the entire session regardless of need.

### 1.3 Why existing solutions don't address this

Secret management platforms were designed for a world where the consumer of a secret is a known, deterministic system — a web server, a CI/CD pipeline, a Kubernetes pod. Access control is configured at deployment time, not at runtime. The trust model assumes that if a system has credentials to access a secret, it should always be allowed to do so.

AI agents break this assumption. An agent's behavior is non-deterministic. It may decide, mid-task, that it needs a secret it wasn't anticipated to need. It may misidentify which secret it requires. It may attempt to access production credentials when it should only be touching development ones. The correct response to a secret access request depends on context that only a human can evaluate: what is the agent doing right now, is this the right secret for this task, and should this particular operation proceed?

None of the major secret management platforms offer runtime approval workflows suitable for this use case:

- **1Password** provides service accounts with static vault-scoped access. There is no per-request approval mechanism. When directly asked by users to build agent-oriented approval workflows, the response was noncommittal.
- **Bitwarden Secrets Manager** uses machine accounts with project-scoped tokens. Access is binary — the token either works or it doesn't. No approval layer exists.
- **HashiCorp Vault** offers Control Groups in its Enterprise tier, which do support multi-party approval. However, this is a paid feature unavailable in the open-source edition, and it is designed for human-to-human approval workflows, not agent-to-human ones.
- **Cloud provider secret managers** (AWS Secrets Manager, Google Cloud Secret Manager, Azure Key Vault) provide IAM-based access control with no concept of interactive approval.

The gap is clear: the industry has robust tools for storing secrets and controlling which systems can access them, but no mechanism for controlling *when* and *why* an AI agent accesses a secret, with human oversight at the point of access.

---

## 2. Threat Model

### 2.1 What we are defending against

Agent Vault is designed to mitigate the following threat categories:

**Overprivileged access.** An agent with access to secrets it doesn't currently need. The principle of least privilege requires that access be scoped to the minimum necessary for the task at hand — not the minimum necessary for all possible tasks the agent might ever perform.

**Unauthorized lateral movement.** An agent that begins with a legitimate task (e.g., running a database migration in staging) and, through hallucination, tool misuse, or prompt injection, attempts to access production credentials or unrelated services.

**Secret leakage through conversation history.** Secrets pasted into agent chat are stored in conversation logs, potentially replicated across devices, backed up by the platform, and exposed in session sharing or debugging. The secret's lifetime extends far beyond the task that needed it.

**Absence of audit trail.** When secrets are pre-loaded or copy-pasted, there is no record of which secrets were accessed, when, by which agent, for what purpose, or whether a human approved the access. Post-incident forensics become impossible.

**Compromised or misbehaving agents.** Whether through prompt injection, model misbehavior, or supply chain compromise of agent tooling, an agent may attempt to exfiltrate secrets. A blanket-access model provides no defense; an approval model limits the blast radius to only the secrets explicitly approved during the session.

### 2.2 Co-located agent self-approval

When Agent Vault runs on the same host as the agent, a critical trust boundary issue arises: the agent has network access to the approval server and can approve its own requests.

The attack is straightforward. The approval server listens on a local port (default 9999). When a secret is requested, a unique approval URL is generated — e.g., `http://localhost:9999/approve/abc123`. The agent is not given this URL directly; it receives only a "waiting for approval" message. However, an agent with shell access can discover the URL by scanning the local port, reading the server's stderr output, or simply brute-forcing the 16-character approval ID space (which, while large, is not the point — the agent could also `curl` the root dashboard endpoint to list all pending requests, or inspect the server's process memory).

This is not a theoretical concern. Any agent running in a typical development environment (Claude Code, Cursor, etc.) has full shell access and can execute arbitrary HTTP requests. The approval workflow provides no security against a co-located agent that decides to bypass it.

**Current mitigations:**

- **ngrok tunneling.** When ngrok is configured, approval URLs use a public ngrok domain rather than localhost. However, the agent can still reach the ngrok URL — it's public by design. Ngrok adds network indirection, not authentication.
- **TTL windows.** Time-scoped approvals limit the blast radius if self-approval occurs, but do not prevent it.
- **Audit logging.** Self-approved requests are logged identically to human-approved ones, making forensic detection possible but not prevention.

**Planned mitigations (see Section 8.2):**

- **Authenticated approval endpoints** — require a token or session cookie that only the human possesses
- **Network isolation** — run the approval server on a separate host or network segment unreachable by the agent
- **Push-based approval** — deliver approval prompts via a channel the agent cannot intercept (push notifications, SMS, authenticator app)

Until these mitigations are implemented, Agent Vault's approval workflow should be considered a **deterrent and audit mechanism** against co-located agents, not a hard security boundary. It is effective against accidental or unintentional secret access (the most common failure mode), but not against a deliberately adversarial agent on the same host.

### 2.3 What we are not defending against

Agent Vault operates at the secret *access* layer, not the secret *usage* layer. Once a secret is approved and delivered to the agent, what the agent does with it is outside Agent Vault's control. This is the same trust boundary that exists when a human developer retrieves a credential from their password manager — the password manager cannot control what happens after the clipboard paste.

Specifically, Agent Vault does not:

- Prevent an agent from using an approved secret for an unintended purpose
- Encrypt secrets in the agent's memory or conversation context
- Prevent the underlying MCP transport from logging tool responses
- Protect against a compromised host operating system intercepting the secret in transit between Agent Vault and the agent process

These are real concerns, but they exist in every current approach to agent secret access. Agent Vault reduces the attack surface by ensuring secrets are only delivered when explicitly approved, are scoped by time and context, and are fully audited.

### 2.4 Security properties

Agent Vault provides the following security properties:

| Property | Mechanism |
|---|---|
| **No standing access** | Agents have zero access to secrets until explicitly approved per-request |
| **Human-in-the-loop** | Every secret access requires human approval via a unique, single-use URL |
| **Least privilege** | Approval is scoped to specific secrets, specific vaults, or time windows — configurable per vault |
| **Audit trail** | Every request, approval, and denial is logged with timestamp, secret name, reason, and scope |
| **Ephemeral transport** | Approval URLs are served via ephemeral ngrok tunnels that exist only for the session lifetime |
| **Single-use tokens** | Each approval URL is invalidated after use — it cannot be replayed or shared |
| **Provider isolation** | Multiple vaults with different providers, different tokens, and different policies can coexist |

---

## 3. Architecture

### 3.1 Overview

Agent Vault is an MCP (Model Context Protocol) server that acts as a proxy between AI agents and secret management systems. It intercepts secret requests, enforces approval workflows, and delivers secrets only after explicit human authorization.

```
┌─────────────┐         ┌──────────────────────────┐         ┌──────────────┐
│  AI Agent    │────────▶│      Agent Vault          │────────▶│  1Password   │
│              │   MCP   │                          │   SDK   │  Bitwarden   │
│  Claude Code │◀────────│  ┌────────┐ ┌────────┐  │◀────────│  Vault       │
│  Cursor      │         │  │ Policy │ │ Audit  │  │         │  AWS SM      │
│  Windsurf    │         │  │ Engine │ │ Log    │  │         │  GCP SM      │
│  Any MCP     │         │  └────────┘ └────────┘  │         │  .env files  │
│  client      │         │  ┌────────────────────┐  │         └──────────────┘
└─────────────┘         │  │  Approval Server   │  │
                        │  │  (Express + ngrok)  │──│──────▶  Your Phone
                        │  └────────────────────┘  │
                        └──────────────────────────┘
```

### 3.2 Components

**MCP Server.** The agent-facing interface. Exposes five tools via the Model Context Protocol: `list_secrets` (enumerate available secrets without revealing values), `get_secret` and `get_secrets` (request one or many secrets with a reason), and `set_secret` and `set_secrets` (create or update secrets in writable vaults). Read and write operations both require human approval. The MCP server communicates with agents via stdio transport, which is the standard for local MCP servers and is supported by all major agent platforms.

**Provider Adapters.** Modular integrations with secret management systems. Each provider implements a three-method interface (`name`, `listSecrets`, `getSecret`), making it trivial to add new backends. The current implementation includes adapters for 1Password (via the official SDK with service accounts) and local `.env` files. The architecture supports running multiple providers simultaneously — for example, a 1Password vault for production secrets alongside an env file for local development tokens.

**Policy Engine.** Determines whether a request requires approval or can be auto-approved based on prior approvals. Operates on two configurable scopes: per-secret (each secret has an independent approval window) and per-vault (approving any secret in a vault opens the entire vault for the configured duration). TTL windows are configurable per vault, allowing organizations to enforce strict approval for production vaults while permitting time-windowed access for development environments.

**Approval Server.** A lightweight HTTP server (Express) that serves approval pages via an ngrok tunnel. When a secret is requested and approval is required, the server generates a unique URL with a random 16-character ID. The URL renders a mobile-friendly page displaying the secret name, the agent's stated reason for access, and approve/deny buttons. The URL is single-use — once acted upon, it is invalidated and cannot be replayed.

**Audit Log.** A SQLite database that records every secret access event: timestamp, secret name, stated reason, action taken (approved, denied, or auto-approved), scope (secret or vault), and TTL expiration. This provides a complete forensic trail for security reviews and incident response.

### 3.3 Write support

Agents don't only consume secrets — they generate them. During bootstrapping, an agent might create API keys, generate database passwords, configure service-to-service tokens, or rotate credentials. Without a structured write path, these generated secrets end up printed to chat, where they are stored in conversation history, potentially logged by the platform, and easily lost.

Agent Vault's write tools (`set_secret`, `set_secrets`) solve this by sending generated credentials directly to the vault with the same approval workflow as reads:

1. The agent calls `set_secret` with a vault name, secret name, value, and reason
2. The approval page displays a **WRITE** badge, the secret name, the reason, and a masked preview of the value (e.g. `sk-********************abc`)
3. The user reviews and approves or denies
4. On approval, the secret is written to the provider (appended to an env file, or created as a new item in 1Password)
5. The value is never printed to the agent's chat or conversation history

Write access is disabled by default and must be explicitly enabled per vault (`writable: true`). For 1Password vaults, a `write` configuration section specifies the target vault ID and item category, ensuring the agent cannot write to arbitrary locations.

The audit log records write operations identically to reads, providing a complete trail of what was created, when, and why.

### 3.4 Request flow

1. The agent calls `get_secret` with a vault name, secret name, and a human-readable reason
2. The policy engine checks for an active approval window (per-secret or per-vault)
3. If permitted, the secret is fetched from the provider and returned immediately
4. If not permitted, the approval server generates a unique URL and logs it to stderr (visible in the agent's terminal output)
5. The `get_secret` tool call **blocks** — the agent cannot proceed
6. The user opens the URL (on their phone, in a browser, wherever), reviews the request, and taps Approve or Deny
7. The approval server resolves the blocked request
8. If approved: the secret is fetched from the provider and returned to the agent; the audit log records the approval with a TTL window if configured
9. If denied: the agent receives a denial message; the audit log records the denial
10. The agent continues (or adjusts its approach if denied)

### 3.5 Configuration model

Agent Vault separates configuration into two layers:

**Structure (committable).** An `agent-vault.config.json` file defines which vaults are available, their types, TTL policies, and scope settings. This file contains no secrets — only references to environment variables via the `env:VAR_NAME` syntax. It is designed to be committed to version control so that teams share a consistent vault configuration.

**Credentials (per-user).** Actual tokens and keys are set as environment variables by each developer or injected by the runtime environment. These are never committed to version control.

This separation means a team can define their vault structure once — "we have a dev vault in 1Password, a prod vault in 1Password, and a shared local secrets file" — and each team member simply sets their own service account tokens.

---

## 4. Portability

### 4.1 Agent-agnostic

Agent Vault uses the Model Context Protocol, which is supported by Claude Code, Cursor, Windsurf, Cline, and a growing list of agent platforms. Any MCP-compatible client can use Agent Vault without modification. The MCP configuration is identical across platforms:

```json
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["agent-vault"],
      "env": {
        "OP_SERVICE_ACCOUNT_TOKEN": "...",
        "NGROK_AUTHTOKEN": "..."
      }
    }
  }
}
```

### 4.2 Environment-agnostic

The same Agent Vault configuration works across:

- **Local development** on a developer's laptop
- **Cloud sandboxes** like GitHub Codespaces, Gitpod, or Devbox
- **Remote agents** running on EC2, GCP Compute, or dedicated servers
- **CI/CD pipelines** where secrets are injected at runtime
- **Claude cloud agents** running in Anthropic's managed infrastructure

The ngrok tunnel ensures that approval links are reachable from any device, regardless of the agent's network environment. A developer monitoring a headless cloud agent from their phone receives the same approval experience as one running Claude Code on their laptop.

### 4.3 Provider-agnostic

The `SecretProvider` interface is deliberately minimal:

```typescript
interface SecretProvider {
  readonly name: string;
  listSecrets(): Promise<SecretEntry[]>;
  getSecret(id: string): Promise<string>;
}
```

Adding a new secret management backend — Bitwarden, HashiCorp Vault, AWS Secrets Manager, Google Cloud Secret Manager, Azure Key Vault, Doppler, Infisical — requires implementing three methods. No lifecycle hooks, no configuration schema, no authentication framework. The provider just needs to list what's available and fetch values on demand.

Multiple providers can run simultaneously. An organization using 1Password for application secrets, AWS Secrets Manager for infrastructure credentials, and Google Cloud Secret Manager for GCP-specific tokens can configure all three as separate vaults, each with independent policies and approval scopes.

---

## 5. Risk-Based Configuration

Agent Vault does not impose a single security policy. Organizations have different risk appetites, and even within a single organization, different environments warrant different levels of control. The configuration model is designed to express this through two dimensions: **TTL** (how long an approval lasts) and **scope** (what an approval covers).

### 5.1 Configuration spectrum

| Risk Level | TTL | Scope | Behavior |
|---|---|---|---|
| Maximum security | `0` | `secret` | Every access to every secret requires explicit approval. No caching. |
| High security | `0` | `secret` | Same as above, but for selected vaults only (e.g., production) |
| Moderate security | `15` | `secret` | After approval, the same secret can be re-fetched for 15 minutes |
| Development convenience | `30` | `vault` | Approve once, entire vault is accessible for 30 minutes |
| Low-risk environment | `60` | `vault` | Approve once at session start, work uninterrupted for an hour |

### 5.2 Multi-vault policies

A common enterprise configuration:

```json
{
  "vaults": {
    "dev": {
      "type": "1password",
      "serviceAccountToken": "env:OP_DEV_TOKEN",
      "ttl": 30,
      "ttlScope": "vault"
    },
    "staging": {
      "type": "1password",
      "serviceAccountToken": "env:OP_STAGING_TOKEN",
      "ttl": 15,
      "ttlScope": "secret"
    },
    "prod": {
      "type": "1password",
      "serviceAccountToken": "env:OP_PROD_TOKEN",
      "ttl": 0,
      "ttlScope": "secret"
    },
    "infra": {
      "type": "env",
      "file": ".env.infra",
      "ttl": 0,
      "ttlScope": "secret"
    }
  }
}
```

This configuration expresses a clear security gradient:
- **Dev:** trusted environment, approve once and work freely
- **Staging:** moderate trust, but each secret is individually tracked
- **Prod:** zero standing access, every request is explicitly approved and audited
- **Infra:** infrastructure credentials with the same strict policy as production

The agent sees all vaults and can request from any of them. The policy engine enforces the appropriate controls transparently.

### 5.3 HITL as a security control

Human-in-the-loop is not just an inconvenience to be minimized — it is a security control. For sensitive operations, the approval prompt serves multiple purposes:

1. **Awareness.** The developer knows that a production deployment is happening *right now*, not at some point during an unmonitored batch run
2. **Context verification.** The stated reason ("Need PROD_DB_PASSWORD to rollback migration 0042") can be evaluated against what the developer knows about the current task
3. **Circuit breaker.** If something looks wrong — an unexpected secret being requested, a reason that doesn't match the task — the developer can deny and investigate
4. **Compliance evidence.** The audit log demonstrates that a human reviewed and approved each access to sensitive resources

For environments where strict compliance is required (SOC 2, HIPAA, PCI DSS), the audit log provides evidence that secret access was authorized by a human, scoped to a specific purpose, and limited in duration.

---

## 6. Observability

### 6.1 The audit gap in agentic development

Security without observability is security theater. An approval workflow that doesn't feed into an organization's existing monitoring infrastructure is only half the solution. When an incident occurs — a secret used inappropriately, an unexpected access pattern, a compromised agent — the first question is always: what happened, when, and who approved it?

Agent Vault's local SQLite audit log provides the forensic record, but forensics happen after the fact. Real-time observability — routing access events into the same logging, alerting, and analytics pipelines that monitor everything else — is what enables detection and response while an incident is still developing.

### 6.2 Webhook-based event delivery

Agent Vault supports configurable webhook endpoints that receive every access event in real time. Events are delivered as JSON POST requests, fire asynchronously, and never block the agent — observability is a side effect of operation, not a dependency.

Each event contains the full context of the access decision:

```json
{
  "event": "secret_access",
  "timestamp": "2026-04-10T14:32:01.000Z",
  "vault": "prod",
  "secrets": ["DATABASE_URL"],
  "reason": "Need database credentials to run migration 0042",
  "action": "approved",
  "scope": "secret",
  "ttlExpiresAt": null
}
```

The webhook configuration supports:

- **Multiple endpoints** — send events to Datadog, Splunk, a custom SIEM, and a Slack channel simultaneously
- **Event filtering** — receive all events, or only specific actions (e.g., only denials)
- **Authenticated delivery** — authorization headers support `env:` references, keeping tokens out of committed config

### 6.3 Operational patterns

**Anomaly detection.** Forward all events to a SIEM or log aggregation platform. Build alerts for patterns that indicate compromise or misuse: an agent requesting secrets from a vault it doesn't normally access, a spike in denied requests (suggesting the agent is probing for access), or requests at unusual times.

**Denial alerting.** Route only `denied` events to a team Slack channel. A denial means either the developer correctly blocked an inappropriate request, or something unexpected is happening. Either way, the team should know.

**Compliance reporting.** Aggregate approved and denied events for periodic security reviews. The combination of the stated reason, the decision, and the timestamp provides the audit evidence required by SOC 2, HIPAA, and PCI DSS frameworks for demonstrating that access to sensitive resources is controlled and reviewed.

**Cost and usage tracking.** For organizations paying for secret manager API calls, tracking which agents access which secrets and how frequently can inform cost optimization and identify unnecessary access patterns.

### 6.4 Integration with existing infrastructure

Because events are standard JSON webhooks, they integrate with any platform that accepts HTTP input:

| Platform | Use case |
|---|---|
| Datadog / New Relic / Grafana | Dashboards, alerting, anomaly detection |
| Splunk / Elastic / Loki | Log aggregation, search, compliance reporting |
| Slack / Teams / PagerDuty | Real-time team notifications for denials |
| Custom HTTP endpoints | Internal security tooling, audit databases |

The webhook model was chosen over specific integrations (e.g., a Datadog SDK) because it is universal, requires no additional dependencies, and works with whatever tooling an organization already uses. The same event format reaches every endpoint, ensuring consistency across the observability stack.

---

## 7. Comparison to Current Approaches

| | Pre-loaded sandbox | Copy-paste | Blanket service account | Agent Vault |
|---|---|---|---|---|
| **Least privilege** | No — all secrets always available | Partial — one at a time, but manual | No — full vault access | Yes — per-secret, per-vault, time-scoped |
| **Human approval** | None | Implicit (human does the paste) | None | Explicit, per-request |
| **Audit trail** | None | None (chat logs are not audit logs) | Provider logs show access, not intent | Full: timestamp, secret, reason, decision |
| **Secret in conversation history** | No | Yes | No | No |
| **Dynamic access** | No — preconfigured only | Yes — but manual | Yes — but uncontrolled | Yes — agent requests, human approves |
| **Multi-vault / multi-provider** | Complex to configure | Manual per secret | One provider at a time | Native support, simultaneous providers |
| **Portable across environments** | Requires per-environment config | Works anywhere (insecurely) | Requires per-environment config | Same config everywhere |
| **Works when agent is unattended** | Yes (insecurely) | No — requires human presence | Yes (insecurely) | Yes — approval via phone from anywhere |

---

## 8. Future Directions

### 8.1 Open source roadmap

The current implementation provides the core approval workflow with 1Password and env file providers. Planned additions include:

- **Additional providers:** Bitwarden Secrets Manager, HashiCorp Vault, AWS Secrets Manager, Google Cloud Secret Manager, Azure Key Vault
- **Secret classification:** Tag secrets with risk levels that map to approval policies automatically
- **Session-scoped access:** Tie approval windows to specific agent sessions rather than wall-clock time
- **Revocation:** Ability to revoke an active approval window mid-session

### 8.2 Approval hardening

The co-located self-approval attack (Section 2.2) is the most significant architectural limitation in the current design. The following mitigations are planned, in order of implementation complexity:

**Authenticated approval endpoints.** Add an HMAC-signed token to each approval URL. The token is derived from a secret that is set at server startup and never exposed to the agent via MCP. The approval server validates the token on every POST to `/approve/:id/yes` and `/approve/:id/no`. Without the token, the request is rejected. This prevents an agent from approving requests by directly hitting the endpoint — even if it discovers the approval ID, it cannot forge the authentication token.

**Separate approval channel.** Move the approval server to a different host, network segment, or process that the agent cannot reach. The MCP handler (which the agent communicates with via stdio) forwards approval requests to the remote approval server over an authenticated channel. The agent's network environment is configured (via firewall rules, container networking, or sandbox policy) to block access to the approval server's address. This is the strongest mitigation for self-hosted deployments and requires no changes to the agent platform.

**Push-based approval.** Replace the pull-based "open this URL" model with push notifications delivered to a channel the agent cannot intercept: mobile push notifications (via a companion app or integration with existing authenticator apps), SMS, or email. The approval decision is sent back to the server via the push channel, not via an HTTP endpoint the agent can reach. This eliminates the network-reachability attack entirely and is the recommended approach for high-security environments.

---

## 9. Conclusion

The agentic development paradigm is not coming — it is here. Developers are running AI agents that write code, manage infrastructure, and interact with production systems. The security practices around this transition have not kept pace.

The current state — secrets in sandboxes, credentials in chat histories, blanket service account access — would be considered unacceptable for human developers, let alone for non-deterministic AI systems. The industry has spent decades building principles like least privilege, separation of duties, and audit trails. Abandoning them because the new tooling doesn't support them is not an option.

Agent Vault provides a practical, immediate solution: a universal proxy that works with any agent, any secret provider, and any environment. It enforces human approval at the point of access, maintains a complete audit trail, and is configurable to match any risk appetite — from strict per-secret approval for production to convenient time-windowed access for development.

The solution is open source, free to use, and installable with a single command. It requires no changes to existing secret management infrastructure, no migration between providers, and no modification to agent platforms. It works because it operates at the correct layer — between the agent and the secret, exactly where the trust decision belongs.

The question is not whether agentic development will become the norm. The question is whether we will build the security infrastructure to support it before the inevitable breach forces our hand.

---

## Appendix A: Quick Start

```bash
# Install
npm install -g agent-vault

# Add to Claude Code MCP config (~/.claude/claude_code_config.json)
{
  "mcpServers": {
    "agent-vault": {
      "command": "npx",
      "args": ["agent-vault"],
      "env": {
        "OP_SERVICE_ACCOUNT_TOKEN": "your_token",
        "NGROK_AUTHTOKEN": "your_token"
      }
    }
  }
}

# Create per-project config (agent-vault.config.json)
{
  "vaults": {
    "1password": {
      "type": "1password",
      "serviceAccountToken": "env:OP_SERVICE_ACCOUNT_TOKEN",
      "ttl": 15,
      "ttlScope": "vault"
    }
  },
  "ngrokAuthToken": "env:NGROK_AUTHTOKEN"
}
```

## Appendix B: Links

- **Repository:** https://github.com/loonshoot/agent_vault
- **MCP Specification:** https://modelcontextprotocol.io
- **1Password Service Accounts:** https://developer.1password.com/docs/service-accounts
