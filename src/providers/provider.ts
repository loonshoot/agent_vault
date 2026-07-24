export interface SecretEntry {
  id: string;
  name: string;
  /** Which vault/project/collection this belongs to */
  group?: string;
}

/**
 * Optional context threaded into a value read. Local providers (env / 1Password)
 * ignore it and read purely by id — their signature stays `getSecret(id)`. The
 * Outrun secrets provider uses `purpose` (the agent's stated reason) as the
 * required purpose on `readSecretFields`, and may key its per-secret metadata
 * lookup off `grantId`. Optional so every existing provider satisfies the
 * interface unchanged.
 */
export interface SecretReadContext {
  /** The agent's stated reason — becomes the required purpose on Outrun reads. */
  purpose?: string;
  /** The management grant this read is happening under, if any. */
  grantId?: string;
}

export interface SecretProvider {
  readonly name: string;

  /** List available secrets (names/IDs only, never values) */
  listSecrets(): Promise<SecretEntry[]>;

  /** Fetch the actual secret value by ID */
  getSecret(id: string, context?: SecretReadContext): Promise<string>;

  /**
   * Create or update a secret. Optional — only providers that support
   * writes need to implement this. Check `canWrite` before calling.
   */
  setSecret?(id: string, value: string): Promise<void>;
}
