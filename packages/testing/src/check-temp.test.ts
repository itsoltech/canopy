import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dockerAvailable } from "../../db/src/testing.ts";
import { tempDirs } from "./temp.ts";

const directory = tempDirs();

test.skipIf(!dockerAvailable || process.platform === "win32")(
  "a descriptor write failure removes the owned PostgreSQL container and temporary directory",
  async () => {
    const root = directory("canopy-tmpcheck-failure-");
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    const removed = join(root, "removed-container");
    const started = join(root, "started-container");
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
case "$1" in
  create)
    for path in "$TMPDIR"/canopy-tmpcheck-*; do
      mkdir "$path/.canopy-test-postgres-port" || exit 1
    done
    "$CANOPY_TEST_DOCKER" "$@" > "$CANOPY_TEST_STARTED_CONTAINER"
    status=$?
    cat "$CANOPY_TEST_STARTED_CONTAINER"
    exit "$status"
    ;;
  rm) printf '%s\\n' "$4" > "$CANOPY_TEST_REMOVED_CONTAINER" ;;
esac
exec "$CANOPY_TEST_DOCKER" "$@"
`,
      { mode: 0o700 },
    );

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "check-temp.ts"), "./packages/transport/src/channel.test.ts"],
      {
        cwd: resolve(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"]}`,
          TMPDIR: tmp,
          CANOPY_TEST_DOCKER: Bun.which("docker")!,
          CANOPY_TEST_REMOVED_CONTAINER: removed,
          CANOPY_TEST_STARTED_CONTAINER: started,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );

    try {
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).not.toBe(0);
      expect(stderr).toContain("EISDIR");
      expect(readdirSync(tmp)).toEqual([]);

      const id = readFileSync(started, "utf8").trim();
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(removed, "utf8").trim()).toBe(id);
      expect(Bun.spawnSync(["docker", "inspect", id], { stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
    } finally {
      // A regression in the runner must not make this regression test leak its own container.
      const id = existsSync(started) ? readFileSync(started, "utf8").trim() : "";

      if (/^[0-9a-f]{64}$/.test(id))
        await Bun.spawn(["docker", "rm", "-f", "-v", id], { stdout: "ignore", stderr: "ignore" }).exited;
    }
  },
  60_000,
);
