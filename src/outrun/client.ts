/**
 * Thin GraphQL-over-gateway client for Outrun-managed secrets.
 *
 * Every call is a POST to `{url}/graphql` with `Authorization: Bearer <apiKey>`
 * — the same gateway-API-key surface Outrun already uses for external clients
 * (a key scoped to the workspace with the `action:secrets` capability). The
 * server side of this contract lands separately; here it is exercised purely
 * against a mocked `globalThis.fetch`.
 *
 * SECURITY: this client handles secret VALUES (readSecretFields) and the API
 * KEY. Neither is ever logged. GraphQL errors are surfaced with their message
 * text only — never the variables (which can contain a purpose) or the data
 * (which can contain values).
 */

export interface OutrunClientConfig {
  /** Gateway base URL — requests POST to `${url}/graphql`. */
  url: string;
  /** Resolved gateway API key (bearer). Never logged. */
  apiKey: string;
  /** Workspace the key is scoped to; passed as `workspaceId` on every op. */
  workspaceId: string;
}

export interface OutrunFieldMeta {
  key: string;
  type?: string;
  description?: string;
  sensitive?: boolean;
}

export interface OutrunSecretMeta {
  id: string;
  name: string;
  description?: string;
  urls?: string[];
  fieldsMeta?: OutrunFieldMeta[];
  /** Decides read routing: 'outrun' → readSecretFields; 'external' → local provider read. */
  storage: "outrun" | "external";
  status?: string;
}

export interface OutrunMount {
  toolId: string;
  displayName: string;
  connectionData: {
    /** '1password' | 'env_file' — mapped to a local SecretProvider by name. */
    provider: string;
    vault?: string;
    itemPrefix?: string;
  };
}

export interface OutrunGrant {
  id: string;
  status: string;
  expiresAt?: string | null;
}

const SECRETS_QUERY = `query Secrets($workspaceId: ID!) {
  secrets(workspaceId: $workspaceId) {
    id name description urls
    fieldsMeta { key type description sensitive }
    storage status
  }
}`;

const MOUNTS_QUERY = `query SecretVaultMounts($workspaceId: ID!) {
  secretVaultMounts(workspaceId: $workspaceId) {
    id displayName provider vault itemPrefix
  }
}`;

const REQUEST_ACCESS_MUTATION = `mutation RequestSecretAccess($workspaceId: ID!, $name: String!, $purpose: String!, $ttlMinutes: Int, $vault: String) {
  requestSecretAccess(workspaceId: $workspaceId, name: $name, purpose: $purpose, ttlMinutes: $ttlMinutes, vault: $vault) {
    grantId: id status
  }
}`;

const GRANT_QUERY = `query SecretGrant($workspaceId: ID!, $grantId: ID!) {
  secretGrant(workspaceId: $workspaceId, grantId: $grantId) {
    id status expiresAt
  }
}`;

const READ_FIELDS_MUTATION = `mutation ReadSecretFields($workspaceId: ID!, $secretId: ID!, $fields: [String!], $purpose: String!, $grantId: ID) {
  readSecretFields(workspaceId: $workspaceId, secretId: $secretId, fields: $fields, purpose: $purpose, grantId: $grantId)
}`;

const LOG_USE_MUTATION = `mutation LogSecretUse($workspaceId: ID!, $grantId: ID!, $purpose: String!) {
  logSecretUse(workspaceId: $workspaceId, grantId: $grantId, purpose: $purpose)
}`;

export class OutrunClient {
  constructor(private config: OutrunClientConfig) {}

  async secrets(): Promise<OutrunSecretMeta[]> {
    const data = await this.gql<{ secrets: OutrunSecretMeta[] }>(SECRETS_QUERY, {
      workspaceId: this.config.workspaceId,
    });
    return data.secrets ?? [];
  }

  async secretVaultMounts(): Promise<OutrunMount[]> {
    const data = await this.gql<{
      secretVaultMounts: Array<{ id: string; displayName: string; provider: string; vault?: string; itemPrefix?: string }>;
    }>(MOUNTS_QUERY, {
      workspaceId: this.config.workspaceId,
    });
    return (data.secretVaultMounts ?? []).map((m) => ({
      toolId: m.id,
      displayName: m.displayName,
      connectionData: { provider: m.provider, vault: m.vault, itemPrefix: m.itemPrefix },
    }));
  }

  async requestSecretAccess(
    name: string,
    purpose: string,
    ttlMinutes?: number,
    vault?: string
  ): Promise<{ grantId: string; status: string }> {
    const data = await this.gql<{ requestSecretAccess: { grantId: string; status: string } }>(
      REQUEST_ACCESS_MUTATION,
      { workspaceId: this.config.workspaceId, name, purpose, ttlMinutes: ttlMinutes ?? null, vault: vault ?? null }
    );
    return data.requestSecretAccess;
  }

  async secretGrant(grantId: string): Promise<OutrunGrant> {
    const data = await this.gql<{ secretGrant: OutrunGrant }>(GRANT_QUERY, {
      workspaceId: this.config.workspaceId,
      grantId,
    });
    return data.secretGrant;
  }

  /** Outrun-stored read: returns the requested `{key: value}` map (TOTP fields arrive as current codes). */
  async readSecretFields(
    secretId: string,
    fields: string[] | undefined,
    purpose: string,
    grantId?: string
  ): Promise<Record<string, string>> {
    const data = await this.gql<{ readSecretFields: Record<string, string> | string }>(
      READ_FIELDS_MUTATION,
      { workspaceId: this.config.workspaceId, secretId, fields: fields ?? null, purpose, grantId: grantId ?? null }
    );
    const raw = data.readSecretFields;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  /**
   * Hybrid-mode use log: called BEFORE a local read. Resolves true when the
   * grant is still valid; a revoked/denied/expired grant surfaces as a thrown
   * error (from the GraphQL error path) so the caller refuses to read locally.
   */
  async logSecretUse(grantId: string, purpose: string): Promise<boolean> {
    const data = await this.gql<{ logSecretUse: boolean }>(LOG_USE_MUTATION, {
      workspaceId: this.config.workspaceId,
      grantId,
      purpose,
    });
    return data.logSecretUse;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.url}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err: any) {
      // Network-level failure — surface a redacted message (no variables/values).
      throw new Error(`Outrun request failed: ${err?.message ?? "network error"}`);
    }

    if (!res.ok) {
      throw new Error(`Outrun returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors && payload.errors.length > 0) {
      // Message text only — never echo variables (purpose) or data (values).
      throw new Error(payload.errors.map((e) => e.message).join("; "));
    }
    if (!payload.data) {
      throw new Error("Outrun returned no data");
    }
    return payload.data;
  }
}
