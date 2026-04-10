import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SecretEntry, SecretProvider } from "./provider.js";

/**
 * Simple provider that reads secrets from a .env-style file.
 * Good for testing without a real password manager.
 */
export class EnvFileProvider implements SecretProvider {
  readonly name = "env-file";
  private secrets: Map<string, string>;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.secrets = parseEnvFile(this.filePath);
  }

  async listSecrets(): Promise<SecretEntry[]> {
    return Array.from(this.secrets.keys()).map((key) => ({
      id: key,
      name: key,
    }));
  }

  async getSecret(id: string): Promise<string> {
    const value = this.secrets.get(id);
    if (value === undefined) {
      throw new Error(`Secret "${id}" not found`);
    }
    return value;
  }

  async setSecret(id: string, value: string): Promise<void> {
    const existing = this.secrets.has(id);
    this.secrets.set(id, value);

    if (existing) {
      // Rewrite the file with the updated value
      const lines: string[] = [];
      const content = readFileSync(this.filePath, "utf-8");
      let replaced = false;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          lines.push(line);
          continue;
        }
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) {
          lines.push(line);
          continue;
        }
        const key = trimmed.slice(0, eqIndex).trim();
        if (key === id) {
          lines.push(`${id}="${value}"`);
          replaced = true;
        } else {
          lines.push(line);
        }
      }
      if (!replaced) {
        lines.push(`${id}="${value}"`);
      }
      writeFileSync(this.filePath, lines.join("\n"));
    } else {
      // Append to file
      appendFileSync(this.filePath, `\n${id}="${value}"\n`);
    }
  }
}

function parseEnvFile(path: string): Map<string, string> {
  const content = readFileSync(path, "utf-8");
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result.set(key, value);
  }
  return result;
}
