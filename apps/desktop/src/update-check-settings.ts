import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { isCheckInterval } from "@canopy/domain/update-checks";

const Stored = Schema.Struct({ minutes: Schema.Number, lastChecked: Schema.Number });

/** Separate from channels: writing either preference never loses the other. */
export class UpdateCheckSettings {
  readonly path: string;
  minutes = 360;
  lastChecked = 0;
  constructor(directory: string) {
    this.path = join(directory, "app-update-checks.json");

    try {
      const stored = Schema.decodeUnknownSync(Stored)(JSON.parse(readFileSync(this.path, "utf8")));

      if (isCheckInterval(stored.minutes)) this.minutes = stored.minutes;

      if (Number.isFinite(stored.lastChecked) && stored.lastChecked >= 0) this.lastChecked = stored.lastChecked;
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT") &&
        !(cause instanceof SyntaxError) &&
        !Schema.isSchemaError(cause)
      )
        throw cause;
    }
  }

  save(minutes: number, lastChecked = this.lastChecked): void {
    if (!isCheckInterval(minutes)) throw new Error("Invalid update check frequency");
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ minutes, lastChecked }) + "\n", { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    this.minutes = minutes;
    this.lastChecked = lastChecked;
  }
}
