import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")(
  "installer passes enrollment only on stdin and reuses the saved config",
  () => {
    const home = mkdtempSync(join(tmpdir(), "canopy-install-fixture-"));

    try {
      const bin = join(home, "bin");
      const worker = join(home, "worker");
      const invocation = join(home, "args");
      const tokenFile = join(home, "token");
      const config = join(home, ".config/canopy/worker.json");

      const binary = `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$CANOPY_TEST_ARGS"
IFS= read -r invitation
printf '%s' "$invitation" > "$CANOPY_TEST_TOKEN"
printf '%s\\n' 'fixture config' > "$5"
`;

      mkdirSync(bin);
      const localBin = join(home, ".local/bin");
      mkdirSync(localBin, { recursive: true });
      writeFileSync(join(localBin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$HOME/.npm-global"\n', { mode: 0o755 });
      writeFileSync(worker, binary);
      writeFileSync(
        join(bin, "curl"),
        '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$CANOPY_TEST_WORKER" "$2"\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n";; -m) printf "x86_64\\n";; esac\n',
        { mode: 0o755 },
      );

      const install = (stdin: string) =>
        Bun.spawnSync(
          [
            "sh",
            join(import.meta.dir, "install-worker.sh"),
            "--gateway",
            "https://gateway.example.invalid",
            "--release-url",
            "https://github.com/itsoltech/canopy/releases/download/v1.2.3/canopy-worker-linux-x64",
            "--release-sha256",
            createHash("sha256").update(binary).digest("hex"),
            "--no-service",
            "--token-stdin",
          ],
          {
            env: {
              ...Bun.env,
              HOME: home,
              PATH: `${bin}:${Bun.env["PATH"] ?? ""}`,
              CANOPY_TEST_ARGS: invocation,
              CANOPY_TEST_TOKEN: tokenFile,
              CANOPY_TEST_WORKER: worker,
            },
            stdin: Buffer.from(stdin),
          },
        );

      const result = install("fixture-invitation\n");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(invocation, "utf8").trimEnd().split("\n")).toEqual([
        "enroll",
        "--gateway",
        "https://gateway.example.invalid",
        "--config",
        config,
      ]);
      expect(readFileSync(tokenFile, "utf8")).toBe("fixture-invitation");
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain("fixture-invitation");

      rmSync(invocation);
      expect(install("").exitCode).toBe(0);
      expect(readFileSync(config, "utf8")).toBe("fixture config\n");
      expect(() => readFileSync(invocation)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
