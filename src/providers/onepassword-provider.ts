import type { SecretEntry, SecretProvider } from "./provider.js";

/**
 * 1Password provider using the official SDK with service accounts.
 *
 * Requires:
 *   npm install @1password/sdk
 *   OP_SERVICE_ACCOUNT_TOKEN env var set
 *
 * Secrets are referenced using op:// URIs, e.g. "op://vault/item/field"
 */
export class OnePasswordProvider implements SecretProvider {
  readonly name = "1password";
  private client: any = null;
  private vaultIds: string[];
  private writeConfig?: { vaultId: string; category: string };
  private authToken: string;

  /**
   * @param authToken - 1Password service account token for authentication.
   * @param vaultIds - Optional list of vault IDs to expose. If empty, all accessible vaults are listed.
   * @param writeConfig - Optional write config specifying which vault and category to create items in.
   */
  constructor(authToken: string, vaultIds: string[] = [], writeConfig?: { vaultId: string; category: string }) {
    this.authToken = authToken;
    this.vaultIds = vaultIds;
    this.writeConfig = writeConfig;
  }

  private async getClient() {
    if (this.client) return this.client;
    // Dynamic import — @1password/sdk is an optional dependency
    // @ts-ignore - optional peer dependency
    const { createClient } = await import("@1password/sdk");
    this.client = await createClient({
      auth: this.authToken,
      integrationName: "agent-vault",
      integrationVersion: "0.1.0",
    });
    return this.client;
  }

  async listSecrets(): Promise<SecretEntry[]> {
    const client = await this.getClient();
    const entries: SecretEntry[] = [];

    let vaultIds = this.vaultIds;
    if (vaultIds.length === 0) {
      const vaults = await client.vaults.list();
      vaultIds = vaults.map((v: any) => v.id);
    }

    for (const vaultId of vaultIds) {
      const items = await client.items.list(vaultId);
      for (const item of items) {
        entries.push({
          id: `op://${vaultId}/${item.id}`,
          name: item.title,
          group: vaultId,
        });
      }
    }

    return entries;
  }

  async getSecret(id: string): Promise<string> {
    const client = await this.getClient();

    // If it's an op:// reference, resolve directly
    if (id.startsWith("op://")) {
      return client.secrets.resolve(id);
    }

    // Otherwise look up item by title across configured vaults
    let vaultIds = this.vaultIds;
    if (vaultIds.length === 0) {
      const vaults = await client.vaults.list();
      vaultIds = vaults.map((v: any) => v.id);
    }

    for (const vaultId of vaultIds) {
      const items = await client.items.list(vaultId);
      const match = items.find((item: any) => item.title === id);
      if (match) {
        const fullItem = await client.items.get(vaultId, match.id);
        // Return all fields as JSON
        const fields: Record<string, string> = {};
        for (const field of fullItem.fields) {
          const key = field.title || field.fieldType || "value";
          if (field.value) {
            fields[key] = field.value;
          }
        }
        return JSON.stringify(fields);
      }
    }

    throw new Error(
      `Secret "${id}" not found. Use the exact item title from list_secrets, or an op://vault/item/field reference.`
    );
  }

  async setSecret(id: string, value: string): Promise<void> {
    if (!this.writeConfig) {
      throw new Error(
        "1Password write config not set. Add a 'write' section to your vault config with 'vaultId' and optionally 'category'."
      );
    }

    const client = await this.getClient();
    const { vaultId, category } = this.writeConfig;

    // Check if item already exists by searching for it
    let existingItem: any = null;
    try {
      const items = await client.items.list(vaultId);
      for (const item of items) {
        if (item.title === id) {
          existingItem = item;
          break;
        }
      }
    } catch {
      // Vault may not be listable — proceed to create
    }

    if (existingItem) {
      // Update existing item — fetch full item, update the password/value field
      const fullItem = await client.items.get(vaultId, existingItem.id);
      for (const field of fullItem.fields) {
        if (field.fieldType === "Concealed" || field.id === "password") {
          field.value = value;
          break;
        }
      }
      await client.items.put(fullItem);
    } else {
      // Create new item
      await client.items.create({
        vaultId,
        title: id,
        category,
        fields: [
          {
            id: "password",
            title: "password",
            fieldType: "Concealed",
            value,
          },
        ],
      });
    }
  }
}
