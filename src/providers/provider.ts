export interface SecretEntry {
  id: string;
  name: string;
  /** Which vault/project/collection this belongs to */
  group?: string;
}

export interface SecretProvider {
  readonly name: string;

  /** List available secrets (names/IDs only, never values) */
  listSecrets(): Promise<SecretEntry[]>;

  /** Fetch the actual secret value by ID */
  getSecret(id: string): Promise<string>;
}
