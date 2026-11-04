import { describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import {
  AgentEnvironmentDesiredSchema,
  AgentEnvironmentReportSchema,
  EnvironmentSkillSchema,
  SkillFileSchema,
  type AgentEnvironmentReport,
  type SkillFile,
} from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { tempDirs } from "@canopy/testing";
import { SkillLedger } from "../../apps/worker/src/agent-environment/skill-ledger.ts";
import { WorkerAgentEnvironment } from "../../apps/worker/src/agent-environment/index.ts";
import { reconcileSkill } from "../../apps/worker/src/agent-environment/skill-reconcile.ts";
import { readSkillTree, writeSkillTree } from "../../apps/worker/src/agent-environment/skill-files.ts";
import type { SkillTarget } from "../../apps/worker/src/agent-environment/skill-targets.ts";
import { grokLaunch } from "../../apps/worker/src/providers/grok/launch.ts";
import { claudeSkillsOnDisk } from "../../apps/worker/src/providers/claude/catalog.ts";
import { claudeSkillPlugins } from "../../apps/worker/src/providers/claude/skill-plugin.ts";
import { skillFiles } from "./support/agent-skills.ts";

const scratch = tempDirs();

function fixture() {
  const root = scratch("canopy-skills-files-");
  const dataDir = join(root, "data");
  const path = join(root, "home/skills/code-review");
  const ledger = new SkillLedger(dataDir);

  const target: SkillTarget = {
    targetId: environmentDigest(`skill:${path}`),
    skillId: Bun.randomUUIDv7(),
    path,
    harness: "codex",
    scope: "platform",
  };

  const version = (files: SkillFile[], version = 1n) => ({
    ...target,
    desired: create(EnvironmentSkillSchema, {
      id: target.skillId,
      version,
      harnesses: ["codex"],
      artifact: validateSkillFiles(files),
      platformHome: true,
    }),
  });

  return { root, dataDir, path, ledger, target, version };
}

describe("skill filesystem transactions and harness destinations", () => {
  test("Claude loads only the managed skill root and rejects unapproved sibling plugin components and links", () => {
    const root = scratch("canopy-skills-plugin-");
    const plugin = join(root, "canopy-environment");
    expect(claudeSkillPlugins(root)).toEqual([]);
    writeSkillTree(join(plugin, "skills/code-review"), skillFiles());
    expect(claudeSkillPlugins(root)).toEqual([{ type: "local", path: plugin }]);

    for (const name of ["hooks", ".mcp.json", ".claude-plugin"]) {
      writeFileSync(join(plugin, name), "unapproved");
      expect(() => claudeSkillPlugins(root)).toThrow("unmanaged components");
      expect(readFileSync(join(plugin, name), "utf8")).toBe("unapproved");
      rmSync(join(plugin, name));
    }

    renameSync(join(plugin, "skills"), join(root, "private-skills"));
    symlinkSync(join(root, "private-skills"), join(plugin, "skills"), "dir");
    expect(() => claudeSkillPlugins(root)).toThrow("symlink");
  });

  test("large concurrent drift reports stay bounded and expose deferred comparisons after another conflict resolves", () => {
    const root = scratch("canopy-skills-report-");

    const files = [
      ...skillFiles(),
      ...Array.from({ length: 7 }, (_, i) =>
        create(SkillFileSchema, { path: `assets/${i}.bin`, content: Buffer.alloc(1024 * 1024) }),
      ),
    ];

    const desired = create(AgentEnvironmentDesiredSchema, {
      revision: 1n,
      skills: [
        {
          id: Bun.randomUUIDv7(),
          version: 1n,
          artifact: validateSkillFiles(files),
          harnesses: ["claude", "codex", "grok"],
          deviceHome: true,
          platformHome: true,
        },
      ],
    });

    let report = create(AgentEnvironmentReportSchema);

    const environment = new WorkerAgentEnvironment({
      homes: () => ({
        dataDir: join(root, "data"),
        config: undefined,
        deviceHomes: {
          claude: join(root, "home/.claude"),
          codex: join(root, "home/.codex"),
        },
      }),
      send: (next: AgentEnvironmentReport) => {
        report = next;
      },
    });

    try {
      environment.apply(desired);
      expect(report.skills.length).toBe(6);
      expect(report.skills.every((s) => s.status === "applied")).toBe(true);

      for (const status of report.skills)
        writeFileSync(
          join(status.path, "SKILL.md"),
          Buffer.from(skillFiles()[0]!.content).toString("utf8") + "Local edit.\n",
        );
      environment.refresh(true);
      expect(Buffer.byteLength(JSON.stringify(toJson(AgentEnvironmentReportSchema, report)))).toBeLessThan(
        128 * 1024 * 1024,
      );
      const deferred = report.skills.find((s) => s.status === "error")!;
      expect(deferred.detail).toContain("Resolve those conflicts first");
      expect(deferred.managedFiles).toEqual([]);
      const conflict = report.skills.find((s) => s.status === "drift")!;
      desired.skillResolutions = [
        {
          $typeName: "canopy.worker.v1.EnvironmentResolution",
          targetId: conflict.targetId,
          action: "overwrite",
          observedChecksum: conflict.observedChecksum,
          desiredChecksum: conflict.desiredChecksum,
        },
      ];
      environment.apply(desired);
      expect(report.skills.find((s) => s.targetId === conflict.targetId)?.status).toBe("applied");
      expect(report.skills.find((s) => s.targetId === deferred.targetId)?.status).toBe("drift");
      expect(readFileSync(join(deferred.path, "SKILL.md"), "utf8")).toContain("Local edit.");
    } finally {
      environment.stop();
    }
  });

  test("Claude catalogs expose the managed plugin namespace from the actual isolated home", () => {
    const f = fixture();
    const home = join(f.root, "claude-home");
    const skill = join(home, "canopy-environment/skills/code-review");
    writeSkillTree(skill, skillFiles());
    const catalog = claudeSkillsOnDisk(f.root, home);
    expect(catalog.get("canopy-environment:code-review")?.path).toBe(join(skill, "SKILL.md"));
    expect(catalog.has("code-review")).toBe(false);
  });
  test("ownership survives restart and idempotence does not rewrite installed files", () => {
    const f = fixture();
    const target = f.version(skillFiles());
    expect(reconcileSkill(target, f.ledger).status).toBe("applied");
    const inode = lstatSync(join(f.path, "SKILL.md")).ino;
    const restarted = new SkillLedger(f.dataDir);
    expect(reconcileSkill(target, restarted).status).toBe("applied");
    expect(lstatSync(join(f.path, "SKILL.md")).ino).toBe(inode);
    expect(restarted.entries.get(target.targetId)?.files).toHaveLength(2);
    const manifest = readFileSync(restarted.path, "utf8");
    expect(manifest).not.toContain("Review the patch carefully.");
  });

  test("manifest write failure rolls back the complete previous version and removes transaction scratch", () => {
    const f = fixture();
    reconcileSkill(f.version(skillFiles()), f.ledger);
    const before = readSkillTree(f.path).checksum;
    rmSync(f.ledger.path);
    mkdirSync(f.ledger.path);
    const result = reconcileSkill(f.version(skillFiles("code-review", "Update that must roll back."), 2n), f.ledger);
    expect(result.status).toBe("error");
    expect(readSkillTree(f.path).checksum).toBe(before);
    expect(readdirSync(dirname(f.path))).toEqual(["code-review"]);
  });

  test("a concurrent edit during rollback is preserved, with the old version in a recovery backup", () => {
    const f = fixture();
    reconcileSkill(f.version(skillFiles()), f.ledger);

    const commit = spyOn(f.ledger, "commit").mockImplementation(() => {
      writeFileSync(join(f.path, "SKILL.md"), "Edited during commit.");
      throw new Error("Simulated failed manifest write.");
    });

    const result = reconcileSkill(f.version(skillFiles("code-review", "New version."), 2n), f.ledger);
    commit.mockRestore();
    expect(result.status).toBe("error");
    expect(readFileSync(join(f.path, "SKILL.md"), "utf8")).toBe("Edited during commit.");
    const backup = join(dirname(f.path), `.canopy-${f.target.targetId}-backup`);
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toContain("Review the patch carefully.");
    expect(reconcileSkill(f.version(skillFiles()), new SkillLedger(f.dataDir)).status).toBe("error");
    expect(readFileSync(join(f.path, "SKILL.md"), "utf8")).toBe("Edited during commit.");
  });

  test("interrupted swaps restore the old version before applying a new desired version", () => {
    const f = fixture();
    reconcileSkill(f.version(skillFiles()), f.ledger);
    const before = readSkillTree(f.path).checksum;
    const parent = dirname(f.path);
    const staging = join(parent, `.canopy-${f.target.targetId}-staging`);
    const backup = join(parent, `.canopy-${f.target.targetId}-backup`);
    writeSkillTree(staging, skillFiles("code-review", "Interrupted update."));
    const after = readSkillTree(staging).checksum;
    writeFileSync(
      join(parent, `.canopy-${f.target.targetId}-transaction.json`),
      JSON.stringify({ before, after, ownership: "uncommitted" }),
    );
    renameSync(f.path, backup);
    renameSync(staging, f.path);
    const result = reconcileSkill(f.version(skillFiles()), new SkillLedger(f.dataDir));
    expect(result.status).toBe("applied");
    expect(readFileSync(join(f.path, "SKILL.md"), "utf8")).toContain("Review the patch carefully.");
    expect(readdirSync(parent)).toEqual(["code-review"]);
  });

  test("unknown files and empty user directories survive update/removal; links and corrupt manifests fail closed", () => {
    const f = fixture();
    reconcileSkill(f.version(skillFiles()), f.ledger);
    writeFileSync(join(f.path, "notes.txt"), "My own notes.");
    mkdirSync(join(f.path, "empty-user-folder"));
    expect(reconcileSkill(f.version(skillFiles("code-review", "Updated."), 2n), f.ledger).status).toBe("applied");
    expect(reconcileSkill(f.target, f.ledger).status).toBe("removed");
    expect(readFileSync(join(f.path, "notes.txt"), "utf8")).toBe("My own notes.");
    expect(existsSync(join(f.path, "empty-user-folder"))).toBe(true);
    expect(existsSync(join(f.path, "SKILL.md"))).toBe(false);
    const linked = fixture();
    reconcileSkill(linked.version(skillFiles()), linked.ledger);
    const outside = join(linked.root, "private.txt");
    writeFileSync(outside, "Private.");
    symlinkSync(outside, join(linked.path, "linked.txt"));
    expect(reconcileSkill(linked.version(skillFiles()), linked.ledger).status).toBe("error");
    expect(readFileSync(outside, "utf8")).toBe("Private.");
    writeFileSync(linked.ledger.path, "invalid json");
    expect(new SkillLedger(linked.dataDir).problem).toContain("unreadable");
  });

  test("Grok process homes read the durable managed skill root, including an instance shadow home", () => {
    const f = fixture();
    const shadow = join(f.root, "instance");
    writeSkillTree(join(shadow, "skills/code-review"), skillFiles());

    const launch = grokLaunch({
      dataDir: f.dataDir,
      profile: { kind: "native", id: "review", providers: ["grok"], env: {}, runtime: { shadowHomePath: shadow } },
      baseEnv: { HOME: join(f.root, "device-home") },
      linkDeviceLogin: false,
    });

    try {
      const home = launch.options.env?.["GROK_HOME"] ?? "";
      expect(readFileSync(join(home, "skills/code-review/SKILL.md"), "utf8")).toContain("Review the patch carefully.");
      expect(launch.options.env?.["GROK_AUTH_PATH"]).toBeUndefined();
    } finally {
      launch.cleanup();
    }

    expect(existsSync(join(shadow, "skills/code-review/SKILL.md"))).toBe(true);
  });
});
