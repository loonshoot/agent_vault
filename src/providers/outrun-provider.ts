import type { SecretEntry, SecretProvider, SecretReadContext } from "./provider.js";
import type { OutrunClient } from "../outrun/client.js";

/**
 * SecretProvider for Outrun-STORED items (`storage: 'outrun'`). The value lives
 * in Outrun (AES-256-GCM at rest) and is served by the `readSecretFields`
 * mutation, which requires a purpose and records the use server-side — so a read
 * through this provider is itself the audited "use" (the management hook does
 * NOT need a separate logUse for these; see OutrunBackend.resolveRead's
 * `logsUseInternally: true`).
 *
 * `getSecret(id)` takes the secret's Outrun id (not its name); the backend
 * resolves name → id from the item metadata before calling. Multi-field items
 * come back as a JSON `{key: value}` object — the same convention the 1Password
 * provider uses — and TOTP fields resolve to the current code, never the seed.
 */
export class OutrunSecretsProvider implements SecretProvider {
  readonly name = "outrun";

  constructor(private client: OutrunClient) {}

  async listSecrets(): Promise<SecretEntry[]> {
    const items = await this.client.secrets();
    return items
      .filter((s) => s.storage === "outrun")
      .map((s) => ({ id: s.id, name: s.name, group: "Outrun" }));
  }

  async getSecret(id: string, context?: SecretReadContext): Promise<string> {
    const purpose = context?.purpose;
    if (!purpose) {
      // The read path always threads the agent's reason through as the purpose;
      // an Outrun-stored read with no purpose would be rejected server-side, so
      // fail fast with a clear message rather than send an empty purpose.
      throw new Error("Outrun-stored reads require a purpose (the request reason).");
    }
    const fields = await this.client.readSecretFields(id, undefined, purpose, context?.grantId);
    const keys = Object.keys(fields);
    // Single-field items return the bare value; multi-field items return the
    // JSON map, matching the 1Password provider's shape.
    if (keys.length === 1) return fields[keys[0]];
    return JSON.stringify(fields);
  }
}
