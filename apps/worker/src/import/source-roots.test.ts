import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderConfigurationMode, ProviderProfileKind, WorkerConfigSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { applyWorkerConfig } from "../config/remote.ts";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { MASK } from "./masking.ts";
import { WorkerImport } from "./service.ts";

function fixture(paths: readonly string[], root: string) {
  const result = applyWorkerConfig(
    create(WorkerConfigSchema, {
      version: 1n,
      profiles: paths.map((sourcePath, index) => ({
        id: `shared-${index}`,
        kind: ProviderProfileKind.NATIVE,
        providers: [Provider.CLAUDE],
        disabled: true,
        userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath },
      })),
    }),
    { which: () => null, version: () => undefined, realDirectory: (path) => path },
  );

  if (!result.applied) throw new Error("Expected source-root fixture configuration");

  return new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(root, "device"), codex: join(root, "codex"), grok: join(root, "grok") }),
    config: () => result.config,
  });
}

test("custom shared configuration roots are scanned read-only, deduplicated and protected before any import", async () => {
  const root = tempDir("canopy-import-config-roots-");
  const home = join(root, "data", "homes", "claude-source-parent");
  installFixtureHome(home, ["claude"]);
  const source = join(home, ".claude");
  const alias = join(root, "alias");
  symlinkSync(source, alias);
  const tilde = `~/${relative(homedir(), source)}`;
  const service = fixture([source, alias, tilde], root);
  const token = "fixture-secret-from-shared-source-123456";
  writeFileSync(join(source, "settings.json"), JSON.stringify({ env: { API_TOKEN: token } }));
  const sessionId = crypto.randomUUID();
  const project = join(source, "projects", "-mask-fixture");
  mkdirSync(project);
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: "first",
      sessionId,
      cwd: home,
      timestamp: "2026-11-16T10:00:00Z",
      version: "2.1.308",
      message: { role: "user", content: `Use ${token}` },
    }) + "\n",
  );
  const before = treeFingerprint(source);

  const scan = await service.scan(["claude"]);
  expect(scan.roots.filter((entry) => !entry.problem).map((entry) => entry.path)).toEqual([source]);
  const imported = scan.threads.find((entry) => entry.nativeId === sessionId);
  expect(imported?.preview).toContain(MASK);
  expect(imported?.preview).not.toContain(token);
  expect(treeFingerprint(source)).toBe(before);
  expect(service.hasCopyManifest("claude", sessionId)).toBe(false);
  expect(service.hasImportRootIntersection("claude", source)).toBe(true);
  expect(service.hasImportRootIntersection("claude", join(source, "projects"))).toBe(true);
  expect(service.hasImportRootIntersection("claude", join(root, "unrelated"))).toBe(false);
});

test("an invalid source fails cleanup closed while other configured roots remain readable", async () => {
  const root = tempDir("canopy-import-invalid-config-root-");
  const home = join(root, "home");
  installFixtureHome(home, ["claude"]);
  const source = join(home, ".claude");
  const service = fixture(["invalid\0directory", source], root);
  const before = treeFingerprint(source);

  const scan = await service.scan(["claude"]);
  expect(scan.roots.some((entry) => entry.problem === "Invalid directory")).toBe(true);
  expect(scan.threads).toHaveLength(2);
  expect(treeFingerprint(source)).toBe(before);
  expect(service.hasImportRootIntersection("claude", join(root, "unrelated"))).toBe(true);
});
