import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, EnvironmentSkillSchema, SkillFileSchema } from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { tempDirs } from "@canopy/testing";
import { Effect } from "effect";
import {
  assertCodexPluginSlot,
  codexPluginVersion,
} from "../../apps/worker/src/agent-environment/codex-plugin-cache.ts";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import { WorkerPlugins } from "../../apps/worker/src/agent-environment/plugins.ts";
import { CodexAppServer } from "../../apps/worker/src/providers/codex/app-server.ts";
import { codexAppServerLaunch } from "../../apps/worker/src/providers/codex/launch.ts";

const scratch = tempDirs();

const manifest = (path: string, value: JsonValue) =>
  create(SkillFileSchema, { path, content: Buffer.from(JSON.stringify(value)) });

function fixture() {
  const root = scratch("canopy-native-plugin-cache-");

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
        harnesses: ["codex"],
        artifact: validatePluginFiles([
          manifest(".claude-plugin/plugin.json", { name: "native-cache-fixture", version: "9.0.0" }),
          manifest(".codex-plugin/plugin.json", { name: "native-cache-fixture", version: "1.2.3" }),
          create(SkillFileSchema, {
            path: "skills/review-cache/SKILL.md",
            content: Buffer.from("---\nname: review-cache\ndescription: Inspect cache ownership.\n---\nRead only.\n"),
          }),
        ]),
      }),
    ],
  });

  const worker = new WorkerPlugins(homes.dataDir);
  const report = worker.reconcile(desired, homes);
  expect(report.every((file) => file.status === "applied")).toBe(true);
  const plugin = report.find((file) => file.skillId)!;
  const home = join(homes.dataDir, "codex-home");

  return { root, homes, desired, worker, plugin, home };
}

describe("Codex native plugin cache ownership", () => {
  test("the preferred manifest determines the native slot even when Claude declares another version", () => {
    const claude = manifest(".claude-plugin/plugin.json", { version: "9.0.0" });
    expect(codexPluginVersion([claude])).toBe("9.0.0");
    expect(
      codexPluginVersion([claude, manifest(".codex-plugin/plugin.json", { version: " 1.2.3-beta+build_1 " })]),
    ).toBe("1.2.3-beta+build_1");
    expect(codexPluginVersion([claude, manifest(".codex-plugin/plugin.json", {})])).toBe("local");
    expect(codexPluginVersion([claude, manifest(".codex-plugin/plugin.json", { version: null })])).toBe("local");

    for (const version of ["", " ", ".", "..", "../escape", "a/b", "a\\b", "a:b", "a b", 1])
      expect(() => codexPluginVersion([claude, manifest(".codex-plugin/plugin.json", { version })])).toThrow();
    expect(() => codexPluginVersion([])).toThrow("manifest");
    expect(() =>
      codexPluginVersion([create(SkillFileSchema, { path: ".codex-plugin/plugin.json", content: Buffer.from("{") })]),
    ).toThrow();
  });

  test("first installation permits missing ancestors, but cache paths and owned files cannot traverse symlinks", () => {
    const root = scratch("canopy-native-cache-path-");
    const slot = join(root, "missing/plugin/1.2.3");
    expect(() => assertCodexPluginSlot("relative/1.2.3")).toThrow("absolute");
    expect(() => assertCodexPluginSlot(slot)).not.toThrow();
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "README.md"), "Approved.");
    expect(() => assertCodexPluginSlot(slot)).not.toThrow();
    symlinkSync(join(slot, "README.md"), join(slot, "extra"));
    expect(() => assertCodexPluginSlot(slot)).toThrow("Symlinks");
    rmSync(join(slot, "extra"));
    symlinkSync(slot, join(root, "linked-parent"));
    expect(() => assertCodexPluginSlot(join(root, "linked-parent/1.2.3"))).toThrow("symlink");
    symlinkSync(slot, join(root, "linked-slot"));
    expect(() => assertCodexPluginSlot(join(root, "linked-slot"))).toThrow("symlink");
    writeFileSync(join(root, "file-slot"), "Not a directory.");
    expect(() => assertCodexPluginSlot(join(root, "file-slot"))).toThrow("directories");
  });

  test("every sibling entry is rejected, including lower versions, files and dangling symlinks", () => {
    for (const name of ["local", "9.0.0", "0.1.0", "notes.txt", "dangling"]) {
      const root = scratch("canopy-native-cache-sibling-");
      const slot = join(root, "1.2.3");
      const sibling = join(root, name);
      mkdirSync(slot);

      if (name === "dangling") symlinkSync(join(root, "absent"), sibling);
      else if (name === "notes.txt") writeFileSync(sibling, "Private.");
      else mkdirSync(sibling);
      expect(() => assertCodexPluginSlot(slot)).toThrow("another entry");
      expect(() => assertCodexPluginSlot(join(root, "not-installed"))).toThrow("another entry");
    }
  });

  test("unreviewed sibling slots block both session loading and reconciliation without deleting private files", () => {
    const f = fixture();
    expect(basename(f.plugin.path)).toBe("1.2.3");
    const foreign = join(dirname(f.plugin.path), "local");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "private.txt"), "Do not take ownership.");
    expect(() => managedPlugins(f.home, "codex")).toThrow("another entry");
    const statuses = f.worker.reconcile(f.desired, f.homes);
    expect(statuses.find((status) => status.skillId)?.status).toBe("error");
    expect(readFileSync(join(foreign, "private.txt"), "utf8")).toBe("Do not take ownership.");
  });
});

const codexBin = process.env["CANOPY_LIVE_CODEX_BIN"] ?? Bun.which("codex");

test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !codexBin)(
  "native Codex forced refresh preserves the approved version slot and restart ownership without inference",
  async () => {
    const f = fixture();
    const before = readFileSync(join(f.plugin.path, ".codex-plugin/plugin.json"), "utf8");

    const launch = codexAppServerLaunch(
      [],
      {
        PATH: process.env["PATH"],
        HOME: f.root,
        USERPROFILE: f.root,
        XDG_CONFIG_HOME: f.root,
        TMPDIR: process.env["TMPDIR"],
        SYSTEMROOT: process.env["SYSTEMROOT"],
      },
      codexBin ?? "codex",
      undefined,
      f.home,
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          const plugins = yield* codex.request("plugin/list", { cwds: [f.root], forceRefetch: true });
          expect(JSON.stringify(plugins)).toContain("native-cache-fixture");
          const listed = yield* codex.request("skills/list", { cwds: [f.root], forceReload: true });

          const skill = listed.data
            .flatMap((entry) => entry.skills)
            .find((entry) => entry.name.endsWith(":review-cache"));

          expect(skill?.path).toBe(join(f.plugin.path, "skills/review-cache/SKILL.md"));
          expect(skill?.enabled).toBe(true);
        }),
      ).pipe(
        Effect.provide(
          CodexAppServer.layer({ launch, clientVersion: "0.0.0-test", onServerRequest: async () => ({}) }),
        ),
        Effect.timeout("30 seconds"),
      ),
    );

    expect(existsSync(f.plugin.path)).toBe(true);
    expect(existsSync(join(dirname(f.plugin.path), "local"))).toBe(false);
    expect(readFileSync(join(f.plugin.path, ".codex-plugin/plugin.json"), "utf8")).toBe(before);
    expect(
      new WorkerPlugins(f.homes.dataDir).reconcile(f.desired, f.homes).every((file) => file.status === "applied"),
    ).toBe(true);
    expect(managedPlugins(f.home, "codex")).toEqual([{ type: "local", path: f.plugin.path }]);
  },
  45_000,
);
