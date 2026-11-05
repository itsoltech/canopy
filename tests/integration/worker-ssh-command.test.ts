import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "@canopy/updater";
import { requireRemoteWorkerAddress, workerSshCommand } from "../../apps/gateway/src/core/worker-ssh-command.ts";

describe("SSH installer command and shell adapter", () => {
  test("refuses absent, loopback and unspecified gateway addresses for another computer", () => {
    for (const url of [
      "",
      "http://localhost:49788",
      "http://127.1",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "http://0.0.0.0",
      "https://[::]",
    ]) {
      expect(() => requireRemoteWorkerAddress(url, "192.0.2.40")).toThrow(
        "Turn on network access or set a gateway address for workers",
      );
    }

    for (const url of ["https://192.0.2.20:23456", "https://100.64.0.20:23456", "https://gateway.example.com"]) {
      expect(() => requireRemoteWorkerAddress(url, "192.0.2.40")).not.toThrow();
    }
  });

  for (const corrupt of [false, true]) {
    test(`fixed SSH stdin downloads without a web origin and ${corrupt ? "rejects tampering before enrollment" : "preserves the gateway and TLS pin during enrollment"}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "canopy-ssh-shell-"));

      const fixture =
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/enroll-args"\nmkdir -p "$HOME/.config/canopy"\nprintf "fixture" > "$HOME/.config/canopy/worker.json"\n';

      const sha256 = createHash("sha256").update(fixture).digest("hex");

      const manifest: ReleaseManifest = {
        schema: 1,
        version: "0.2.0-nightly.74",
        channel: "nightly",
        commit: "fixture",
        published_at: "2026-11-05T00:00:00Z",
        protocol: { worker_link: 1, update: 1 },
        assets: [
          {
            app: "worker",
            os: "linux",
            arch: "x64",
            name: "canopy-worker-linux-x64",
            size: fixture.length,
            url: "https://github.com/itsoltech/canopy/releases/download/v0.2.0-nightly.74/canopy-worker-linux-x64",
            sha256,
          },
        ],
      };

      const setup = create(ui.GetWorkerSetupResponseSchema, {
        gatewayUrl: "https://gateway.example.com:23456",
        gatewayFingerprint: "b".repeat(64),
      });

      try {
        mkdirSync(join(directory, "bin"));
        await Bun.write(join(directory, "download"), corrupt ? "corrupted bytes" : fixture);
        await Bun.write(
          join(directory, "bin/curl"),
          '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "-o" ]; then cp "$HOME/download" "$2"; exit; fi\nshift\ndone\nexit 1\n',
        );
        chmodSync(join(directory, "bin/curl"), 0o755);

        const input =
          workerSshCommand(setup, manifest, "0.2.0-nightly.75", "fixture-enrollment", "Worker's computer") +
          '\nset -- "$@" --no-service\n' +
          (await Bun.file("scripts/install-worker.sh").text());

        const proc = Bun.spawn(["sh", "-s"], {
          stdin: new Blob([input]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: directory, PATH: `${directory}/bin:${process.env["PATH"]}` },
        });

        const [output, errors, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        expect(output).toContain("Using compatible GitHub channel release 0.2.0-nightly.74");
        expect(output + errors).not.toContain("fixture-enrollment");

        if (corrupt) {
          expect(code).toBe(1);
          expect(errors).toContain("SHA-256 mismatch");
          expect(existsSync(join(directory, "enroll-args"))).toBe(false);
          expect(existsSync(join(directory, ".local/share/canopy/bin/canopy-worker"))).toBe(false);
        } else {
          expect(code).toBe(0);
          const args = readFileSync(join(directory, "enroll-args"), "utf8").split("\n");
          expect(args).toContain(setup.gatewayUrl);
          expect(args).toContain(setup.gatewayFingerprint);
          expect(output).toContain("Worker's computer");
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
