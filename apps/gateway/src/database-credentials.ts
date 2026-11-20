import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

type Environment = Readonly<Record<string, string | undefined>>;

/** A file-backed password lets the gateway mount its own login read-only. */
export function databaseUrl(env: Environment): string {
  const value = env["CANOPY_DATABASE_URL"];

  if (!value) throw new Error("CANOPY_DATABASE_URL is required");
  const file = env["CANOPY_DATABASE_PASSWORD_FILE"];

  if (!file) return value;
  const url = URL.parse(value);

  if (!url) throw new Error("CANOPY_DATABASE_URL is invalid");
  url.password = encodeURIComponent(readPassword(file));

  return url.href;
}

function readPassword(file: string): string {
  const password = readFileSync(file, "utf8").trimEnd();

  if (!password) throw new Error("The database password file is empty");

  return password;
}

function generatedPassword(file: string): string {
  if (!existsSync(file)) {
    const temp = `${file}.${randomUUID()}`;
    writeFileSync(temp, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600, flush: true });

    try {
      // Publish a complete file only if nobody else has already chosen the password.
      linkSync(temp, file);
    } catch (error) {
      if (!existsSync(file)) throw error;
    } finally {
      unlinkSync(temp);
    }
  }

  return readPassword(file);
}

export function provisionedPassword(env: Environment, bootstrapUrl: string): string | undefined {
  const runtimeUrl = env["CANOPY_DATABASE_RUNTIME_URL"];
  const file = env["CANOPY_DATABASE_RUNTIME_PASSWORD_FILE"];

  if (file && runtimeUrl) throw new Error("Choose one runtime credential source");

  if (file) return generatedPassword(file);

  if (!runtimeUrl) return undefined;
  const admin = new URL(bootstrapUrl);
  const runtime = new URL(runtimeUrl);

  if (
    runtime.host !== admin.host ||
    runtime.pathname !== admin.pathname ||
    runtime.username !== "canopy_runtime" ||
    runtime.protocol !== admin.protocol ||
    !runtime.password
  )
    throw new Error("The runtime URL must name canopy_runtime in the migration database");

  return decodeURIComponent(runtime.password);
}
