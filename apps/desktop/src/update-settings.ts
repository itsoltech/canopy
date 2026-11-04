import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesktopChannel } from "./identity.ts";
import { isDesktopChannel } from "./update-releases.ts";

/** Independent of gateway configuration and credentials. */
export class UpdateSettings {
  private readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, "app-updates.json");
  }
  read(fallback: DesktopChannel): DesktopChannel {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const channel = value && typeof value === "object" && "channel" in value ? value.channel : undefined;

      return isDesktopChannel(channel) ? channel : fallback;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }
  write(channel: DesktopChannel) {
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ channel }) + "\n", { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
