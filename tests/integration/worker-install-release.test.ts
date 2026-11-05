import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "@canopy/updater";
import { GatewayUpdates } from "../../apps/gateway/src/updates/runtime.ts";
import { workerInstall } from "../../apps/gateway/src/updates/install.ts";

function manifest(version: string, protocol = 1): ReleaseManifest {
  return {
    schema: 1,
    version,
    channel: version.includes("nightly") ? "nightly" : version.includes("beta") ? "beta" : "stable",
    commit: "fixture",
    published_at: "2026-11-05T00:00:00Z",
    protocol: { worker_link: protocol, update: 1 },
    assets: [
      {
        app: "worker",
        os: "linux",
        arch: "x64",
        name: "canopy-worker-linux-x64",
        url: `https://github.com/itsoltech/canopy/releases/download/v${version}/canopy-worker-linux-x64`,
        sha256: "a".repeat(64),
        size: 42,
      },
    ],
  };
}

describe("worker install release adapter with offline GitHub fixtures", () => {
  for (const channel of ["nightly", "beta", "stable"]) {
    for (const selection of ["exact", "fallback", "unavailable"]) {
      test(`${channel}: ${selection} release selection`, async () => {
        const exact = selection === "exact";
        const version = channel === "stable" ? "1.0.1" : `1.1.0-${channel}.74`;
        const newest = channel === "stable" ? "1.0.4" : `1.1.0-${channel}.77`;
        const compatible = channel === "stable" ? "1.0.3" : `1.1.0-${channel}.76`;
        const wrongUpdate = channel === "stable" ? "1.0.5" : `1.1.0-${channel}.78`;
        const incomplete = channel === "stable" ? "1.0.6" : `1.1.0-${channel}.79`;

        const manifests = [
          manifest(version),
          manifest(newest, 2),
          manifest(compatible, selection === "unavailable" ? 2 : 1),
          { ...manifest(wrongUpdate), protocol: { worker_link: 1, update: 2 } },
          { ...manifest(incomplete), assets: [] },
        ];

        const release = (m: ReleaseManifest) => ({
          tag_name: `v${m.version}`,
          prerelease: m.channel !== "stable",
          draft: false,
          assets: [{ name: "manifest.json", browser_download_url: `https://fixture.example/manifest/${m.version}` }],
        });

        const directory = mkdtempSync(join(tmpdir(), "canopy-install-release-"));

        const updates = new GatewayUpdates({
          version,
          channel,
          cacheDir: directory,
          kind: "source",
          authenticate: async () => undefined,
          persistence: {
            admin: async () => true,
            channel: async () => channel,
            setChannel: async () => {},
            workers: async () => [],
            hello: async () => {},
            saveCommand: async () => {},
            report: async () => {},
          },
          source: {
            fetch: async (input) => {
              const url = new URL(String(input));

              if (url.pathname.endsWith("/releases")) return Response.json(manifests.slice(1).map(release));

              if (url.pathname.includes("/releases/tags/"))
                return exact ? Response.json(release(manifests[0]!)) : new Response(null, { status: 404 });
              const selected = manifests.find((m) => url.pathname === `/manifest/${m.version}`);

              return selected ? Response.json(selected) : new Response(null, { status: 404 });
            },
          },
        });

        try {
          const chunks = [];

          const download = workerInstall(
            updates,
            {
              $typeName: "canopy.ui.v1.FetchWorkerInstallRequest",
              os: "linux",
              arch: "x64",
              metadataOnly: true,
              channelFallback: true,
            },
            new AbortController().signal,
          );

          if (selection === "unavailable") {
            await expect(download[Symbol.asyncIterator]().next()).rejects.toThrow(
              "No compatible worker release is available",
            );

            return;
          }

          for await (const chunk of download) chunks.push(chunk);
          expect(chunks[0]?.version).toBe(exact ? version : compatible);
          expect(chunks[0]?.downloadUrl).toContain(`/v${exact ? version : compatible}/`);
          expect(chunks[0]?.sha256).toBe("a".repeat(64));
        } finally {
          updates.close();
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
