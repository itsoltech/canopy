import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseUrl } from "../database-credentials.ts";

type Tool = "psql" | "pg_dump" | "pg_restore";

export class DatabaseMigrationError extends Error {}

export interface PostgresConnection {
  readonly argument: string;
  readonly env: NodeJS.ProcessEnv;
}

export const psqlFlags = [
  "--no-psqlrc",
  "--no-password",
  "--quiet",
  "--set=ON_ERROR_STOP=1",
  "--set=VERBOSITY=sqlstate",
];

function toolEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "SystemRoot",
    "TMP",
    "TEMP",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];

  return {
    PATH: process.env["PATH"],
    ...Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("PG") || inherited.includes(name))),
    LC_ALL: "C",
    CANOPY_MIGRATION_OWNER: createHash("sha256")
      .update(env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost")
      .digest("hex"),
  };
}

function migrationUrl(env: NodeJS.ProcessEnv) {
  if (!env["CANOPY_DATABASE_URL"])
    throw new DatabaseMigrationError("Set CANOPY_DATABASE_URL to the PostgreSQL admin URL.");

  try {
    return databaseUrl(env);
  } catch {
    throw new DatabaseMigrationError("Check CANOPY_DATABASE_URL and CANOPY_DATABASE_PASSWORD_FILE.");
  }
}

function connectionOptions(source: string) {
  // Preserve libpq URI syntax, including socket paths, multiple hosts, and options left to libpq.
  const match = /^(postgres(?:ql)?:\/\/)([^/?]*)([^?]*)(?:\?(.*))?$/s.exec(source);

  if (!match?.[1]) throw new DatabaseMigrationError("CANOPY_DATABASE_URL must be a PostgreSQL URL.");

  const authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  const passwordAt = authority.indexOf(":");

  let password =
    passwordAt >= 0 && passwordAt < at ? decodeURIComponent(authority.slice(passwordAt + 1, at)) : undefined;

  const safeAuthority =
    passwordAt >= 0 && passwordAt < at ? authority.slice(0, passwordAt) + authority.slice(at) : authority;

  const options: string[] = [];
  const hidden = new Map<string, string>();
  let hasService = false;

  for (const part of match[4]?.split("&") ?? []) {
    const equals = part.indexOf("=");
    const name = decodeURIComponent(equals === -1 ? part : part.slice(0, equals));

    if (name === "password") {
      password = decodeURIComponent(part.slice(equals + 1));
    } else if (name === "sslpassword" || name === "oauth_client_secret") {
      const value = decodeURIComponent(part.slice(equals + 1));

      // A libpq service file is line-oriented.
      if (value.includes("\n") || value.includes("\r") || value.includes("\0") || value !== value.trim())
        throw new Error();
      hidden.set(name, value);
    } else {
      if (name === "service") hasService = true;
      options.push(part);
    }
  }

  return { url: match[1] + safeAuthority + (match[3] ?? ""), password, options, hidden, hasService };
}

export async function withPostgresConnection<A>(
  env: NodeJS.ProcessEnv,
  use: (connection: PostgresConnection) => Promise<A>,
): Promise<A> {
  const url = migrationUrl(env);
  let settings: ReturnType<typeof connectionOptions>;

  try {
    settings = connectionOptions(url);

    if (settings.password?.includes("\0")) throw new Error();
  } catch {
    throw new DatabaseMigrationError("CANOPY_DATABASE_URL must be a valid PostgreSQL URL.");
  }

  const childEnv = toolEnvironment(env);

  // Service entries take precedence over PGPASSWORD. Keep explicit credentials from being silently overridden.
  if ((settings.password !== undefined || settings.hidden.size > 0) && (settings.hasService || childEnv["PGSERVICE"]))
    throw new DatabaseMigrationError("Put PostgreSQL service credentials in the libpq service file.");

  if (settings.password !== undefined) childEnv["PGPASSWORD"] = settings.password;

  if (!settings.hidden.size) {
    const query = settings.options.length ? `?${settings.options.join("&")}` : "";

    return use({ argument: `--dbname=${settings.url}${query}`, env: childEnv });
  }

  // libpq provides no environment variable for a TLS client-key password.
  const directory = await mkdtemp(join(tmpdir(), "canopy-pg-"));
  const file = join(directory, "pg_service.conf");

  try {
    const options = [...settings.hidden].map(([name, value]) => `${name}=${value}`);
    await writeFile(file, `[canopy_migration]\n${options.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    const query = ["service=canopy_migration", ...settings.options].join("&");

    return await use({ argument: `--dbname=${settings.url}?${query}`, env: { ...childEnv, PGSERVICEFILE: file } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function spawnPostgres<Stdin extends "ignore" | ReadableStream<Uint8Array>, Stderr extends "pipe" | "ignore">(
  tool: Tool,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: Stdin,
  stderr: Stderr,
) {
  try {
    return Bun.spawn([tool, ...args], { env, stdin, stdout: "pipe", stderr });
  } catch {
    throw new DatabaseMigrationError(`Install a compatible PostgreSQL ${tool} on PATH.`);
  }
}

export async function postgresOutput(
  tool: Tool,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  error: string,
  script?: string,
) {
  const stdin = script === undefined ? "ignore" : new Blob([script]).stream();
  const child = spawnPostgres(tool, args, env, stdin, "ignore");
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  if (code !== 0) throw new DatabaseMigrationError(error);

  return output.trimEnd();
}

export async function requirePostgresTool(tool: Tool, env: NodeJS.ProcessEnv, minimumMajor: number) {
  const message = `Install PostgreSQL ${tool} ${minimumMajor} or newer.`;
  const version = await postgresOutput(tool, ["--version"], env, message);
  const match = /\(PostgreSQL\) (\d+)/.exec(version);

  if (!match || Number(match[1]) < minimumMajor) throw new DatabaseMigrationError(message);

  return Number(match[1]);
}
