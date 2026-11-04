/**
 * `bun run check:tmp [bun test arguments]`: runs the tests with a private TMPDIR and fails when they leave a temp
 * directory of theirs there (`canopy-*`: a test, or a process it started, that does not clean up). Private, so other runs on the machine writing to
 * /tmp at the same time do not count; new /tmp/canopy-* entries made meanwhile are listed as a hint only (live
 * recordings, CANOPY_LIVE_RECORD_DIR, are kept on purpose under fixed names).
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../../db/src/testing.ts";
import { startTestPostgresServer } from "../../db/src/testing-server.ts";

const shared = tmpdir();
const ours = (name: string) => name.startsWith("canopy-");
const before = new Set(readdirSync(shared).filter(ours));
const postgres = dockerAvailable ? await startTestPostgresServer() : undefined;
const tmp = mkdtempSync(join(shared, "canopy-tmpcheck-"));
const descriptor = join(tmp, ".canopy-test-postgres-port");

// The private TMPDIR already reaches fixtures. Keep test infrastructure out of provider environments.
if (postgres) writeFileSync(descriptor, String(postgres.port), { mode: 0o600 });

let code = 1;

try {
  const proc = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ["inherit", "inherit", "inherit"],
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => proc.kill(signal));

  code = await proc.exited;
} finally {
  await postgres?.stop();

  if (postgres) rmSync(descriptor);
}

// Harness CLIs keep their own runtime files in TMPDIR (sockets, compile caches, sandbox mount targets): not ours.
const all = readdirSync(tmp);
const left = all.filter(ours);
const others = all.filter((name) => !ours(name));
const meanwhile = readdirSync(shared).filter((name) => ours(name) && !before.has(name) && join(shared, name) !== tmp);

rmSync(tmp, { recursive: true, force: true });

if (others.length > 0) console.warn(`\ncheck:tmp: left by the tools the tests ran (not checked): ${others.join(", ")}`);

if (meanwhile.length > 0)
  console.warn(`\ncheck:tmp: new in ${shared} during the run (maybe other runs'): ${meanwhile.join(", ")}`);

if (left.length > 0) {
  console.error(
    `\ncheck:tmp: the tests left ${left.length} entr${left.length === 1 ? "y" : "ies"} in their temp dir: ${left.join(", ")}`,
  );
  process.exit(1);
}

console.log(`\ncheck:tmp: nothing left in the temp dir`);

process.exit(code);
