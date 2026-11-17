import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, EnvironmentSkillSchema, SkillFileSchema } from "@canopy/contracts";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { tempDirs } from "@canopy/testing";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import { WorkerPlugins } from "../../apps/worker/src/agent-environment/plugins.ts";

const scratch = tempDirs();

function fixture() {
  const root = scratch("canopy-plugin-cache-");

  const homes = {
    dataDir: join(root, "data"),
    deviceHomes: { claude: join(root, "device/claude"), codex: join(root, "device/codex") },
    config: undefined,
  };

  const desired = create(AgentEnvironmentDesiredSchema, {
    plugins: [
      create(EnvironmentSkillSchema, {
        id: Bun.randomUUIDv7(),
        version: 1n,
        platformHome: true,
        harnesses: ["claude", "codex"],
        artifact: validatePluginFiles([
          create(SkillFileSchema, {
            path: ".claude-plugin/plugin.json",
            content: Buffer.from(JSON.stringify({ name: "cache-fixture" })),
          }),
        ]),
      }),
    ],
  });

  const worker = new WorkerPlugins(homes.dataDir);
  const report = worker.reconcile(desired, homes);
  expect(report.every((file) => file.status === "applied")).toBe(true);
  const plugin = report.find((file) => file.skillId && file.harness === "claude")!;
  const home = join(homes.dataDir, "claude-home");
  const marker = join(plugin.path, ".in_use/12345");
  mkdirSync(join(plugin.path, ".in_use"));
  writeFileSync(marker, JSON.stringify({ pid: 12345 }));

  return { homes, desired, worker, plugin, home, marker };
}

describe("active Claude plugin cache metadata", () => {
  test("live PID markers survive restart, update, removal and reassignment without disabling approved code", () => {
    const f = fixture();
    expect(managedPlugins(f.home, "claude")).toEqual([{ type: "local", path: f.plugin.path }]);
    const restarted = new WorkerPlugins(f.homes.dataDir);
    expect(restarted.reconcile(f.desired, f.homes).every((file) => file.status === "applied")).toBe(true);
    const assignment = f.desired.plugins[0]!;
    assignment.version++;
    assignment.artifact = validatePluginFiles([
      ...assignment.artifact!.files,
      create(SkillFileSchema, { path: "README.md", content: Buffer.from("Approved update.") }),
    ]);
    expect(restarted.reconcile(f.desired, f.homes).every((file) => file.status === "applied")).toBe(true);
    expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify({ pid: 12345 }));
    expect(managedPlugins(f.home, "claude")).toHaveLength(1);

    const empty = create(AgentEnvironmentDesiredSchema);
    expect(restarted.reconcile(empty, f.homes).every((file) => file.status === "removed")).toBe(true);
    expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify({ pid: 12345 }));
    expect(managedPlugins(f.home, "claude")).toEqual([]);
    expect(
      new WorkerPlugins(f.homes.dataDir).reconcile(f.desired, f.homes).every((file) => file.status === "applied"),
    ).toBe(true);
    expect(managedPlugins(f.home, "claude")).toHaveLength(1);
  });

  test("existing marker conflicts heal; code drift still requires a fresh overwrite without reporting markers", () => {
    const f = fixture();
    expect(f.worker.reconcile(f.desired, f.homes).every((file) => file.status === "applied")).toBe(true);
    const manifest = join(f.plugin.path, ".claude-plugin/plugin.json");
    writeFileSync(manifest, JSON.stringify({ name: "edited-plugin" }));
    expect(() => managedPlugins(f.home, "claude")).toThrow("changed locally");
    const drift = f.worker.reconcile(f.desired, f.homes).find((file) => file.targetId === f.plugin.targetId)!;
    expect(drift.status).toBe("drift");
    expect(drift.managedFiles.map((file) => file.path)).not.toContain(".in_use/12345");
    f.desired.pluginResolutions = [
      {
        $typeName: "canopy.worker.v1.EnvironmentResolution",
        targetId: drift.targetId,
        action: "overwrite",
        observedChecksum: drift.observedChecksum,
        desiredChecksum: drift.desiredChecksum,
      },
    ];
    expect(f.worker.reconcile(f.desired, f.homes).every((file) => file.status === "applied")).toBe(true);
    expect(managedPlugins(f.home, "claude")).toHaveLength(1);
    expect(readFileSync(f.marker, "utf8")).toBe(JSON.stringify({ pid: 12345 }));
  });

  test("reserved metadata still rejects symlinks; arbitrary plugin additions and Codex markers stay blocked", () => {
    const f = fixture();
    rmSync(f.marker);
    symlinkSync(join(f.plugin.path, ".claude-plugin/plugin.json"), f.marker);
    expect(() => managedPlugins(f.home, "claude")).toThrow("Symlinks");
    expect(f.worker.reconcile(f.desired, f.homes).find((file) => file.targetId === f.plugin.targetId)?.status).toBe(
      "error",
    );
    rmSync(f.marker);
    writeFileSync(join(f.plugin.path, "extra.txt"), "Private extra.");
    const report = f.worker.reconcile(f.desired, f.homes);
    expect(report.find((file) => file.targetId === f.plugin.targetId)?.status).toBe("drift");
    const codex = report.find((file) => file.skillId && file.harness === "codex")!;
    mkdirSync(join(codex.path, ".in_use"));
    writeFileSync(join(codex.path, ".in_use/12345"), "Unapproved Codex file.");
    expect(() => managedPlugins(join(f.homes.dataDir, "codex-home"), "codex")).toThrow("changed locally");
    expect(f.worker.reconcile(f.desired, f.homes).find((file) => file.targetId === codex.targetId)?.status).toBe(
      "drift",
    );
  });
});
