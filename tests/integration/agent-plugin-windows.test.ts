import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, SkillFileSchema } from "@canopy/contracts";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { skillManifestDigest } from "@canopy/domain/skill-artifact";
import { tempDirs } from "@canopy/testing";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import { WorkerPlugins } from "../../apps/worker/src/agent-environment/plugins.ts";

const scratch = tempDirs();
const script = "hooks/session-start";

function fixture(platform: NodeJS.Platform = "win32") {
  const root = scratch("canopy-plugin-windows-");

  const homes = {
    dataDir: join(root, "data"),
    deviceHomes: { claude: join(root, "device/claude"), codex: join(root, "device/codex") },
    config: undefined,
  };

  const artifact = validatePluginFiles([
    create(SkillFileSchema, {
      path: ".claude-plugin/plugin.json",
      content: Buffer.from(JSON.stringify({ name: "windows-fixture" })),
    }),
    create(SkillFileSchema, { path: script, content: Buffer.from("#!/bin/sh\necho approved\n"), executable: true }),
  ]);

  const desired = create(AgentEnvironmentDesiredSchema, {
    plugins: [{ id: Bun.randomUUIDv7(), version: 1n, platformHome: true, harnesses: ["claude", "codex"], artifact }],
  });

  const worker = new WorkerPlugins(homes.dataDir, platform);
  const report = worker.reconcile(desired, homes);
  expect(report.every((status) => status.status === "applied")).toBe(true);
  const bundles = report.filter((status) => status.skillId);

  return { homes, desired, worker, bundles, artifact };
}

/** Match Windows libuv fstat: regular files never report executable bits, even after creation with 0700. */
function windowsModes(f: ReturnType<typeof fixture>) {
  for (const bundle of f.bundles) chmodSync(join(bundle.path, script), 0o600);
}

function expectLaunch(f: ReturnType<typeof fixture>, platform: NodeJS.Platform = "win32") {
  for (const bundle of f.bundles)
    expect(managedPlugins(join(f.homes.dataDir, `${bundle.harness}-home`), bundle.harness, platform)).toEqual([
      { type: "local", path: bundle.path },
    ]);
}

describe("managed plugin installation with Windows file modes", () => {
  test("approved executables launch, survive repeated reconciliation and retain canonical ownership after restart", () => {
    const f = fixture();
    const canonical = f.artifact.checksum;
    windowsModes(f);
    expectLaunch(f);

    for (const worker of [f.worker, new WorkerPlugins(f.homes.dataDir, "win32")]) {
      const report = worker.reconcile(f.desired, f.homes);
      expect(report.every((status) => status.status === "applied")).toBe(true);
      expectLaunch(f);

      for (const bundle of f.bundles) {
        const entry = worker.ledger.entries.get(bundle.targetId)!;
        expect(entry.files.find((file) => file.path === script)?.executable).toBe(true);
        expect(entry.checksum).toBe(skillManifestDigest(entry.files));
        expect(report.find((status) => status.targetId === bundle.targetId)?.desiredChecksum).toBe(entry.checksum);
        // A repeat must not replace the installed files to try to restore unsupported executable bits.
        expect(statSync(join(bundle.path, script)).mode & 0o111).toBe(0);
      }
    }

    expect(f.artifact.checksum).toBe(canonical);
    expect(skillManifestDigest(f.artifact.files)).toBe(canonical);
    expect(f.artifact.files.find((file) => file.path === script)?.executable).toBe(true);
  });

  test("an existing canonical receipt and ownership ledger heal through reconciliation without overwrite", () => {
    const f = fixture("linux");
    windowsModes(f);

    for (const bundle of f.bundles)
      expect(() => managedPlugins(join(f.homes.dataDir, `${bundle.harness}-home`), bundle.harness, "win32")).toThrow(
        "changed locally",
      );

    const ledgerBefore = readFileSync(f.worker.ledger.path, "utf8");
    const restarted = new WorkerPlugins(f.homes.dataDir, "win32");
    expect(restarted.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);
    expect(readFileSync(f.worker.ledger.path, "utf8")).toBe(ledgerBefore);
    expectLaunch(f);
  });

  test("approved upgrades and removal use restored ownership despite missing executable bits", () => {
    const f = fixture();
    windowsModes(f);
    const assignment = f.desired.plugins[0]!;
    assignment.version++;
    assignment.artifact = validatePluginFiles(
      f.artifact.files.map((file) =>
        file.path === script
          ? create(SkillFileSchema, { ...file, content: Buffer.from("#!/bin/sh\necho updated\n") })
          : file,
      ),
    );
    const restarted = new WorkerPlugins(f.homes.dataDir, "win32");
    expect(restarted.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);
    windowsModes(f);
    expectLaunch(f);

    for (const bundle of f.bundles) expect(readFileSync(join(bundle.path, script), "utf8")).toContain("updated");

    const removed = new WorkerPlugins(f.homes.dataDir, "win32").reconcile(
      create(AgentEnvironmentDesiredSchema),
      f.homes,
    );

    expect(removed.every((status) => status.status === "removed")).toBe(true);

    for (const bundle of f.bundles) {
      expect(existsSync(join(bundle.path, script))).toBe(false);
      expect(managedPlugins(join(f.homes.dataDir, `${bundle.harness}-home`), bundle.harness, "win32")).toEqual([]);
    }
  });

  test("content edits, missing files and unapproved additions still block launch and reconciliation", () => {
    const f = fixture();
    windowsModes(f);

    for (const bundle of f.bundles) {
      const home = join(f.homes.dataDir, `${bundle.harness}-home`);
      const path = join(bundle.path, script);
      const original = readFileSync(path);
      writeFileSync(path, "Locally changed code.");
      expect(() => managedPlugins(home, bundle.harness, "win32")).toThrow("changed locally");
      expect(f.worker.reconcile(f.desired, f.homes).find((s) => s.targetId === bundle.targetId)?.status).toBe("drift");
      expect(() => managedPlugins(home, bundle.harness, "win32")).toThrow("attention");
      writeFileSync(path, original);
      expect(f.worker.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);

      rmSync(path);
      expect(() => managedPlugins(home, bundle.harness, "win32")).toThrow("changed locally");
      expect(f.worker.reconcile(f.desired, f.homes).find((s) => s.targetId === bundle.targetId)?.status).toBe("drift");
      writeFileSync(path, original, { mode: 0o600 });
      expect(f.worker.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);

      const extra = join(bundle.path, "unapproved.txt");
      writeFileSync(extra, "Unapproved plugin component.");
      expect(() => managedPlugins(home, bundle.harness, "win32")).toThrow("changed locally");
      expect(f.worker.reconcile(f.desired, f.homes).find((s) => s.targetId === bundle.targetId)?.status).toBe("drift");
      rmSync(extra);
      expect(f.worker.reconcile(f.desired, f.homes).every((status) => status.status === "applied")).toBe(true);
    }

    expectLaunch(f);
  });

  test.skipIf(process.platform === "win32")("Windows projection still rejects symlinks in approved paths", () => {
    const f = fixture();
    windowsModes(f);

    for (const bundle of f.bundles) {
      const path = join(bundle.path, script);
      rmSync(path);
      symlinkSync(join(bundle.path, ".claude-plugin/plugin.json"), path);
      expect(() => managedPlugins(join(f.homes.dataDir, `${bundle.harness}-home`), bundle.harness, "win32")).toThrow(
        "Symlinks",
      );
      const restarted = new WorkerPlugins(f.homes.dataDir, "win32");
      expect(restarted.reconcile(f.desired, f.homes).find((s) => s.targetId === bundle.targetId)?.status).toBe("error");
    }
  });

  test.skipIf(process.platform === "win32")("POSIX executable-only edits continue to block launch and drift", () => {
    const f = fixture("linux");
    expectLaunch(f, "linux");
    windowsModes(f);

    for (const bundle of f.bundles)
      expect(() => managedPlugins(join(f.homes.dataDir, `${bundle.harness}-home`), bundle.harness, "linux")).toThrow(
        "changed locally",
      );

    const report = new WorkerPlugins(f.homes.dataDir, "linux").reconcile(f.desired, f.homes);

    for (const bundle of f.bundles)
      expect(report.find((status) => status.targetId === bundle.targetId)?.status).toBe("drift");
  });
});
