import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, SkillFileSchema } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { skillManifestDigest } from "@canopy/domain/skill-artifact";
import { tempDirs } from "@canopy/testing";
import { WorkerPlugins } from "../../apps/worker/src/agent-environment/plugins.ts";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import { reconcilePluginConfig } from "../../apps/worker/src/agent-environment/plugin-config.ts";
import { SkillLedger } from "../../apps/worker/src/agent-environment/skill-ledger.ts";
import { readSkillTree } from "../../apps/worker/src/agent-environment/skill-files.ts";

const scratch = tempDirs();

function artifact(version: string, text = "Approved code.") {
  return validatePluginFiles([
    create(SkillFileSchema, {
      path: ".codex-plugin/plugin.json",
      content: Buffer.from(JSON.stringify({ name: "migration-fixture", version })),
    }),
    create(SkillFileSchema, { path: "README.md", content: Buffer.from(text) }),
  ]);
}

function fixture() {
  const root = scratch("canopy-plugin-migration-");

  const homes = {
    dataDir: join(root, "data"),
    deviceHomes: { claude: join(root, "device/claude"), codex: join(root, "device/codex") },
    config: undefined,
  };

  const desired = create(AgentEnvironmentDesiredSchema, {
    plugins: [
      { id: Bun.randomUUIDv7(), version: 1n, harnesses: ["codex"], platformHome: true, artifact: artifact("1.2.3") },
    ],
  });

  const worker = new WorkerPlugins(homes.dataDir);
  const report = worker.reconcile(desired, homes);
  expect(report.every((status) => status.status === "applied")).toBe(true);
  const bundle = report.find((status) => status.skillId)!;
  const home = join(homes.dataDir, "codex-home");

  return { root, homes, desired, worker, bundle, home };
}

/** Recreate an owned installation written by the old worker before Codex refreshes it. */
function legacy(f: ReturnType<typeof fixture>) {
  const path = join(dirname(f.bundle.path), "local");
  const targetId = environmentDigest(`skill:${path}`);
  const entry = f.worker.ledger.entries.get(f.bundle.targetId)!;
  renameSync(f.bundle.path, path);
  f.worker.ledger.relocate(entry.targetId, { ...entry, path, targetId });
  const configPath = join(f.home, "config.toml");
  const current = readFileSync(configPath, "utf8");
  const content = current.split("# canopy:plugins:begin\n")[1]!.split("# canopy:plugins:end")[0]!;
  expect(
    reconcilePluginConfig(
      {
        harness: "codex",
        scope: "platform",
        active: true,
        path: configPath,
        content: { kind: "toml", value: content.replaceAll(JSON.stringify(f.bundle.path), JSON.stringify(path)) },
      },
      f.worker.config,
    ).status,
  ).toBe("applied");

  return { path, targetId };
}

function assertReady(f: ReturnType<typeof fixture>, path = f.bundle.path) {
  expect(managedPlugins(f.home, "codex")).toEqual([{ type: "local", path }]);
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toContain(JSON.stringify(path));
}

describe("owned Codex cache version transitions", () => {
  test("an invalid replacement version still removes retired activation and blocks session loading", () => {
    const f = fixture();
    const oldId = f.desired.plugins[0]!.id;
    const replacementId = Bun.randomUUIDv7();

    const replacement = create(AgentEnvironmentDesiredSchema, {
      plugins: [{ ...f.desired.plugins[0]!, id: replacementId, artifact: artifact("../outside") }],
    });

    const report = f.worker.reconcile(replacement, f.homes);
    expect(report.find((status) => status.skillId === replacementId)?.status).toBe("error");
    expect(existsSync(f.bundle.path)).toBe(false);
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).not.toContain(oldId);
    expect(() => managedPlugins(f.home, "codex")).toThrow("attention");
  });

  test("retirement interrupted after its ownership commit recovers transaction cleanup on restart", () => {
    const f = fixture();
    const backup = join(dirname(f.bundle.path), `.canopy-${f.bundle.targetId}-backup`);
    const journal = join(dirname(f.bundle.path), `.canopy-${f.bundle.targetId}-transaction.json`);
    const before = readSkillTree(f.bundle.path);
    const previous = f.worker.ledger.entries.get(f.bundle.targetId)!;
    const tombstone = { ...previous, checksum: skillManifestDigest([]), files: [] };

    // Recreate a committed removal interrupted before backup and journal cleanup.
    renameSync(f.bundle.path, backup);
    mkdirSync(f.bundle.path);
    f.worker.ledger.commit(f.bundle.targetId, tombstone);
    writeFileSync(
      journal,
      JSON.stringify({
        before: before.checksum,
        after: readSkillTree(f.bundle.path).checksum,
        ownership: environmentDigest(JSON.stringify(tombstone)),
      }),
    );
    f.desired.plugins[0]!.artifact = artifact("2.0.0");

    const restarted = new WorkerPlugins(f.homes.dataDir);
    expect(
      restarted.reconcile(f.desired, f.homes).every((status) => ["applied", "removed"].includes(status.status)),
    ).toBe(true);
    expect(restarted.ledger.entries.has(f.bundle.targetId)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    assertReady(f, join(dirname(f.bundle.path), "2.0.0"));
  });

  test("retirement retains ownership until the final empty directory is removed", () => {
    const f = fixture();
    const previous = f.worker.ledger.entries.get(f.bundle.targetId)!;

    // Recreate completed transaction cleanup with the final empty cache slot still present.
    rmSync(f.bundle.path, { recursive: true });
    mkdirSync(f.bundle.path);
    f.worker.ledger.commit(f.bundle.targetId, { ...previous, checksum: skillManifestDigest([]), files: [] });
    f.desired.plugins[0]!.artifact = artifact("2.0.0");

    const restarted = new WorkerPlugins(f.homes.dataDir);
    expect(
      restarted.reconcile(f.desired, f.homes).every((status) => ["applied", "removed"].includes(status.status)),
    ).toBe(true);
    expect(restarted.ledger.entries.has(f.bundle.targetId)).toBe(false);
    expect(existsSync(f.bundle.path)).toBe(false);
    assertReady(f, join(dirname(f.bundle.path), "2.0.0"));
  });

  test("an existing owned local installation retires before the manifest version is activated", () => {
    const f = fixture();
    const old = legacy(f);
    const restarted = new WorkerPlugins(f.homes.dataDir);
    const report = restarted.reconcile(f.desired, f.homes);
    expect(report.find((status) => status.targetId === old.targetId)?.status).toBe("removed");
    expect(
      report.filter((status) => status.targetId !== old.targetId).every((status) => status.status === "applied"),
    ).toBe(true);
    expect(existsSync(old.path)).toBe(false);
    assertReady(f);
  });

  test("native relocation transfers exact ownership atomically and heals without overwrite", () => {
    const f = fixture();
    const old = legacy(f);
    renameSync(old.path, f.bundle.path);
    const restarted = new WorkerPlugins(f.homes.dataDir);
    expect(restarted.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);
    const ledger = new SkillLedger(f.homes.dataDir, "plugins.json");
    expect(ledger.entries.has(old.targetId)).toBe(false);
    expect(ledger.entries.get(f.bundle.targetId)?.owned).toBe(true);
    assertReady(f);
  });

  test("an interrupted ownership write preserves the old journal and recovers on retry", () => {
    const f = fixture();
    const old = legacy(f);
    renameSync(old.path, f.bundle.path);
    const restarted = new WorkerPlugins(f.homes.dataDir);

    const write = spyOn(restarted.ledger, "relocate").mockImplementation(() => {
      throw new Error("Simulated write failure.");
    });

    try {
      expect(restarted.reconcile(f.desired, f.homes).some((status) => status.status === "drift")).toBe(true);
      expect(new SkillLedger(f.homes.dataDir, "plugins.json").entries.has(old.targetId)).toBe(true);
      expect(() => managedPlugins(f.home, "codex")).toThrow("attention");
    } finally {
      write.mockRestore();
    }

    expect(restarted.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);
    assertReady(f);
  });

  test("upgrades and downgrades remove the previously owned version before native selection", () => {
    const f = fixture();
    const assignment = f.desired.plugins[0]!;
    let previous = f.bundle.path;

    for (const version of ["2.0.0", "0.9.0"]) {
      assignment.version++;
      assignment.artifact = artifact(version);
      const report = new WorkerPlugins(f.homes.dataDir).reconcile(f.desired, f.homes);
      expect(report.every((status) => ["applied", "removed"].includes(status.status))).toBe(true);
      expect(existsSync(previous)).toBe(false);
      previous = join(dirname(previous), version);
      assertReady(f, previous);
    }
  });

  test("changed old code blocks upgrades, and private additions in retired slots are preserved", () => {
    for (const filename of ["README.md", "private.txt"]) {
      const f = fixture();
      writeFileSync(join(f.bundle.path, filename), "Locally owned bytes.");
      f.desired.plugins[0]!.artifact = artifact("2.0.0");
      const report = new WorkerPlugins(f.homes.dataDir).reconcile(f.desired, f.homes);
      expect(report.some((status) => ["drift", "error"].includes(status.status))).toBe(true);
      expect(readFileSync(join(f.bundle.path, filename), "utf8")).toBe("Locally owned bytes.");
      expect(existsSync(join(dirname(f.bundle.path), "2.0.0"))).toBe(false);
      expect(() => managedPlugins(f.home, "codex")).toThrow("attention");
    }
  });

  test("relocated modified bundles, extra files, empty directories and symlinks are never adopted", () => {
    for (const change of ["code", "extra", "directory", "symlink"]) {
      const f = fixture();
      const old = legacy(f);
      renameSync(old.path, f.bundle.path);

      if (change === "code") writeFileSync(join(f.bundle.path, "README.md"), "Modified.");
      else if (change === "extra") writeFileSync(join(f.bundle.path, "private.txt"), "Private.");
      else if (change === "directory") mkdirSync(join(f.bundle.path, "private"));
      else symlinkSync(join(f.bundle.path, "README.md"), join(f.bundle.path, "private"));
      const worker = new WorkerPlugins(f.homes.dataDir);
      expect(worker.reconcile(f.desired, f.homes).some((status) => ["error", "drift"].includes(status.status))).toBe(
        true,
      );
      expect(worker.ledger.entries.has(old.targetId)).toBe(true);
      expect(worker.ledger.entries.has(f.bundle.targetId)).toBe(false);
      expect(existsSync(f.bundle.path)).toBe(true);
      expect(() => managedPlugins(f.home, "codex")).toThrow("attention");
    }
  });

  test("unassignment removes an exactly relocated owned bundle and its activation", () => {
    const f = fixture();
    const old = legacy(f);
    renameSync(old.path, f.bundle.path);
    const worker = new WorkerPlugins(f.homes.dataDir);
    expect(
      worker.reconcile(create(AgentEnvironmentDesiredSchema), f.homes).every((status) => status.status === "removed"),
    ).toBe(true);
    expect(existsSync(f.bundle.path)).toBe(false);
    expect(worker.ledger.entries.size).toBe(0);
    expect(managedPlugins(f.home, "codex")).toEqual([]);
  });
});
