import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, tempDirs } from "@canopy/testing";
import {
  bunCheckSpawn,
  checkPostgres,
  PostgresCheckError,
  type CheckOptions,
  type CheckProcess,
} from "../src/runtime/postgres-check.ts";
import { PostgresInstaller } from "../src/runtime/postgres-install.ts";
import { postgresArchive, postgresRegistry } from "./postgres-fixture.ts";

const makeTemp = tempDirs();
const stage = "/data/postgres/versions/pin.download/install";

interface Fake {
  exit?: number;
  signal?: string;
  after?: number;
  stdout?: string;
  stderr?: string;
  /** Exit only on SIGKILL, like a launch waiting in a security assessment. */
  hang?: "until-kill" | "forever";
}

function fakeSpawn(plan: Record<string, Fake>, kills: string[] = []) {
  return (path: string): CheckProcess => {
    const name = path.split("/").at(-1)!;
    const fake = plan[name] ?? { exit: 0, stdout: `${name} (PostgreSQL) 18.6` };
    let signal: string | null = null;
    let finish: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => (finish = resolve));

    if (!fake.hang)
      setTimeout(() => {
        signal = fake.signal ?? null;
        finish(fake.signal ? null : (fake.exit ?? 0));
      }, fake.after ?? 0);

    const output =
      fake.hang === "forever"
        ? new Promise<never>(() => {})
        : exited.then(() => ({ stdout: fake.stdout ?? "", stderr: fake.stderr ?? "" }));

    return {
      exited,
      output,
      signal: () => signal,
      kill: (value) => {
        kills.push(`${name}:${value}`);

        if (fake.hang === "until-kill" && value === "SIGKILL") {
          signal = value;
          finish(null);
        }
      },
    };
  };
}

const options = (spawn: CheckOptions["spawn"], budget = 300): CheckOptions => ({
  budget,
  slowAfter: 50,
  grace: 50,
  spawn,
});

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (!(error instanceof PostgresCheckError)) throw new Error("Expected a PostgreSQL check failure");

  return error;
}

const never = () => new AbortController().signal;

test("a launch stuck in a security assessment is killed within the budget and reported as a timeout", async () => {
  const kills: string[] = [];
  const started = performance.now();

  const error = await failure(
    checkPostgres(
      stage,
      18,
      never(),
      () => {},
      options(fakeSpawn({ postgres: { hang: "until-kill" } }, kills)),
      "darwin",
    ),
  );

  expect(performance.now() - started).toBeLessThan(1_000);
  expect(error.kind).toBe("timeout");
  expect(kills).toEqual(["postgres:SIGKILL"]);
  expect(error.message).toBe(
    "PostgreSQL did not respond within 1 min. macOS may still be checking it for security. Try again.",
  );
  expect(error.detail).toContain("binary=postgres");
  expect(error.detail).toContain("timedOut=true");
});

test("a process that never exits or closes its output cannot hang the check", async () => {
  const started = performance.now();

  const error = await failure(
    checkPostgres(stage, 18, never(), () => {}, options(fakeSpawn({ pg_ctl: { hang: "forever" } })), "linux"),
  );

  // Budget plus one grace period for the exit and one for the output.
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(error.kind).toBe("timeout");
  expect(error.detail).toContain("binary=pg_ctl");
  expect(error.message).toContain("Your computer may still be checking it");
});

test("a slow first launch shows progress and passes inside the shared budget", async () => {
  const messages: string[] = [];
  const spawn = fakeSpawn({ postgres: { after: 120, stdout: "postgres (PostgreSQL) 18.6" } });

  const timings = await checkPostgres(
    stage,
    18,
    never(),
    (message) => messages.push(message),
    options(spawn),
    "darwin",
  );

  expect(messages).toEqual(["Checking PostgreSQL with macOS security… This can take a minute the first time."]);
  expect(timings).toMatch(/^PostgreSQL first launch: postgres \d+ ms, pg_ctl \d+ ms, initdb \d+ ms$/);
});

test("signals, failed exits and wrong versions name their cause and keep paths out of the message", async () => {
  const blocked = await failure(
    checkPostgres(
      stage,
      18,
      never(),
      () => {},
      options(fakeSpawn({ postgres: { signal: "SIGKILL", stderr: `${stage}/bin/postgres: Killed: 9` } })),
      "darwin",
    ),
  );

  expect(blocked.kind).toBe("blocked");
  expect(blocked.message).toContain("System Settings → Privacy & Security");
  expect(blocked.detail).toContain('stderr="<runtime>/bin/postgres: Killed: 9"');
  expect(blocked.detail).toContain("signal=SIGKILL");
  expect(blocked.detail).not.toContain(stage);

  const library = fakeSpawn({ initdb: { exit: 1, stderr: "dyld: Library not loaded: libicuuc.77.dylib" } });
  const failed = await failure(checkPostgres(stage, 18, never(), () => {}, options(library), "darwin"));
  expect(failed.kind).toBe("failed");
  expect(failed.detail).toContain("binary=initdb exit=1");
  expect(failed.detail).toContain("Library not loaded");

  const version = fakeSpawn({ pg_ctl: { stdout: "pg_ctl (PostgreSQL) 17.2" } });
  const wrong = await failure(checkPostgres(stage, 18, never(), () => {}, options(version), "darwin"));
  expect(wrong.kind).toBe("version");
  expect(wrong.detail).toContain('stdout="pg_ctl (PostgreSQL) 17.2"');
});

test("cancelling a check kills the running launch at once", async () => {
  const kills: string[] = [];
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);
  const spawn = fakeSpawn({ postgres: { hang: "until-kill" } }, kills);

  await expect(checkPostgres(stage, 18, abort.signal, () => {}, options(spawn, 60_000), "darwin")).rejects.toThrow();
  expect(kills).toEqual(["postgres:SIGKILL"]);
});

const fixture = postgresArchive(tempDir("canopy-postgres-check-fixture-"));
const server = await postgresRegistry(fixture.bytes);

afterAll(() => server.close());

test("a failed first launch keeps the verified download, logs the cause and the retry installs from it", async () => {
  const data = makeTemp("canopy-postgres-check-retry-");
  const log: string[] = [];
  const blocked = fakeSpawn({ postgres: { signal: "SIGKILL", stderr: "Killed: 9" } });

  const first = new PostgresInstaller(
    fixture.manifest,
    data,
    () => {},
    server,
    (line) => log.push(line),
    options(blocked),
  );

  await expect(first.ensure(never())).rejects.toThrow("stopped PostgreSQL from running");
  expect(existsSync(first.directory)).toBe(false);
  expect(log.some((line) => line.includes("PostgreSQL check failed (blocked): binary=postgres"))).toBe(true);
  // Only the verified archive stays: no extracted tree or stage directory from the failed attempt.
  const download = readdirSync(join(data, "versions")).find((entry) => entry.endsWith(".download"))!;
  expect(readdirSync(join(data, "versions", download))).toEqual(["package.tgz.partial"]);

  const real = { budget: 60_000, slowAfter: 5_000, grace: 2_000, spawn: bunCheckSpawn };

  const retry = new PostgresInstaller(
    fixture.manifest,
    data,
    () => {},
    server,
    (line) => log.push(line),
    real,
  );

  expect(await retry.ensure(never())).toBe(retry.directory);
  expect(server.ranges).toHaveLength(1);
  expect(readdirSync(join(data, "versions"))).toEqual([retry.directory.split(/[\\/]/).at(-1)!]);
  expect(log.at(-1)).toMatch(/^PostgreSQL first launch: postgres \d+ ms/);
}, 120_000);
