import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Schema } from "effect";
import {
  exportConsolidationProjection,
  loadApprovedConsolidationSecrets,
  verifyConsolidationProjection,
} from "../../../gateway/src/migration/consolidation-projection.ts";
import type { RuntimePaths } from "./config.ts";
import type { MigrationJournal } from "./migration-state.ts";

export const sourceOwnerEmail = "dev@localhost";
const positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const manifestDecoder = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      archiveSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
  ),
);

const capacityDecoder = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      postgresMajor: positive,
      databaseBytes: positive,
    }),
  ),
);

const fenceDecoder = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.String.check(Schema.isUUID()),
      fence: Schema.NullOr(Schema.Literals(["draining", "drained", "committed"])),
    }),
  ),
);

export function migrationEnvironment(
  database: { adminUrl: string; binaries: string; major: number },
  env: NodeJS.ProcessEnv,
  secretsKey: string,
) {
  const paths = [join(database.binaries, "bin")];
  const major = database.major;

  if (process.platform === "darwin")
    paths.push(`/opt/homebrew/opt/postgresql@${major}/bin`, `/usr/local/opt/postgresql@${major}/bin`);
  else if (process.platform === "linux") paths.push(`/usr/lib/postgresql/${major}/bin`);
  else if (process.platform === "win32" && env["PROGRAMFILES"])
    paths.push(join(env["PROGRAMFILES"], "PostgreSQL", String(major), "bin"));
  paths.push(env["PATH"] ?? "");

  return {
    ...env,
    CANOPY_DATABASE_URL: database.adminUrl,
    CANOPY_DEV_USER_EMAIL: sourceOwnerEmail,
    CANOPY_SECRETS_KEY: secretsKey,
    PATH: paths.join(delimiter),
  };
}

export class MigrationSourceError extends Error {}

export async function migrationTools(env: NodeJS.ProcessEnv, major: number, signal: AbortSignal) {
  const tool = async (name: string) => {
    const path = Bun.which(name, { PATH: env["PATH"] ?? "" });

    if (!path) return false;
    const process = Bun.spawn([path, "--version"], { env, signal, stdout: "pipe", stderr: "ignore" });
    const [code, output] = await Promise.all([process.exited, new Response(process.stdout).text()]);
    const match = /\(PostgreSQL\) (\d+)/.exec(output);

    return code === 0 && !!match && Number(match[1]) >= major;
  };

  const tools = await Promise.all([tool("psql"), tool("pg_dump")]);

  if (!tools.every(Boolean))
    throw new MigrationSourceError(
      `Install PostgreSQL ${major} or newer client tools (psql and pg_dump) and restart Canopy.`,
    );
}

export class MigrationSource {
  constructor(
    private readonly directory: string,
    private readonly paths: RuntimePaths,
    private readonly signal: AbortSignal,
  ) {}

  async capacity(env: NodeJS.ProcessEnv) {
    return capacityDecoder(await this.command(env, ["capacity"]));
  }
  async fence(env: NodeJS.ProcessEnv, journal: MigrationJournal, action: "drain" | "status" | "commit" | "abort") {
    const result = fenceDecoder(await this.command(env, ["fence", action, "--run", journal.runId]));

    if (result.runId !== journal.runId) throw new Error("The source returned a different migration run");

    return result.fence;
  }
  async stage(journal: MigrationJournal, env: NodeJS.ProcessEnv, offline: boolean) {
    const privateDirectory = this.directoryFor(journal);
    const path = join(privateDirectory, offline ? "final" : "trial");
    mkdirSync(privateDirectory, { mode: 0o700, recursive: true });
    const existing = existsSync(join(path, "manifest.json"));

    if (!existing) await rm(path, { recursive: true, force: true });

    if (journal.kind === "join") {
      const manifest = existing
        ? await verifyConsolidationProjection(path)
        : await exportConsolidationProjection(env, path, { operationId: journal.runId, offline });

      return { path, manifest };
    }

    const args = [existing ? "verify" : "export", "--bundle", path, ...(!existing && offline ? ["--offline"] : [])];
    const manifest = manifestDecoder(await this.command(env, args));

    return { path, manifest };
  }
  async approvedSecrets(
    env: NodeJS.ProcessEnv,
    journal: MigrationJournal,
    archiveSha256: string,
    approvedSecretIds: readonly string[],
  ) {
    const secrets = await loadApprovedConsolidationSecrets(env, join(this.directoryFor(journal), "final"), {
      operationId: journal.runId,
      archiveSha256,
      approvedSecretIds,
    });

    if (Buffer.byteLength(JSON.stringify(secrets)) > 16 * 1024 * 1024)
      throw new MigrationSourceError("The approved secrets are too large to transfer.");

    return secrets;
  }
  clear(journal: MigrationJournal, trialOnly = false) {
    const directory = this.directoryFor(journal);

    return rm(trialOnly ? join(directory, "trial") : directory, { recursive: true, force: true });
  }
  private directoryFor(journal: MigrationJournal) {
    return join(this.directory, `migration-${journal.runId}`);
  }
  private async command(env: NodeJS.ProcessEnv, args: string[]) {
    const { bun, gateway } = this.paths;

    const subprocess = Bun.spawn([bun, gateway, "migration", ...args], {
      cwd: dirname(gateway),
      env,
      signal: this.signal,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    const [code, output] = await Promise.all([subprocess.exited, new Response(subprocess.stdout).text()]);

    if (code !== 0) throw new Error("The local gateway migration command failed");

    return output;
  }
}
