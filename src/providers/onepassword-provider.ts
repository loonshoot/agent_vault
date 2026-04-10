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

  /**
   * @param vaultIds - Optional list of vault IDs to expose. If empty, all accessible vaults are listed.
   */
  constructor(vaultIds: string[] = []) {
    this.vaultIds = vaultIds;
  }

  private async getClient() {
    if (this.client) return this.client;
    // Dynamic import — @1password/sdk is an optional dependency
    // @ts-ignore - optional peer dependency
    const { createClient } = await import("@1password/sdk");
    this.client = await createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
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
      const vaults = await client.vaults.listAll();
      vaultIds = [];
      for await (const vault of vaults) {
        vaultIds.push(vault.id);
      }
    }

    for (const vaultId of vaultIds) {
      const items = await client.items.listAll(vaultId);
      for await (const item of items) {
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

    // If it's already an op:// reference, resolve directly
    if (id.startsWith("op://")) {
      return client.secrets.resolve(id);
    }

    // Otherwise treat it as a raw item reference — caller should use op:// format
    throw new Error(
      `Invalid secret reference "${id}". Use op://vault/item/field format.`
    );
  }
}
