import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
  AgentEnvironmentDesiredSchema,
  AgentEnvironmentReportSchema,
  EnvironmentResolutionSchema,
  EnvironmentSkillStatusSchema,
  type EnvironmentSkillStatus,
} from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { tempDirs } from "@canopy/testing";
import { WorkerAgentEnvironment } from "../../apps/worker/src/agent-environment/index.ts";
import { inventorySkills } from "../../apps/worker/src/agent-environment/skill-inventory.ts";
import { SkillLedger } from "../../apps/worker/src/agent-environment/skill-ledger.ts";
import { archiveSkillCopy } from "../../apps/worker/src/agent-environment/skill-archive.ts";
import { withSkillDirectory } from "../../apps/worker/src/agent-environment/skill-directory.ts";
import { skillTargets } from "../../apps/worker/src/agent-environment/skill-targets.ts";
import { reconcileSkill } from "../../apps/worker/src/agent-environment/skill-reconcile.ts";
import { skillFiles } from "./support/agent-skills.ts";

const scratch = tempDirs();

function fixture() {
  const parent = realpathSync(scratch("canopy-skill-inventory-"));
  const dataDir = join(parent, "worker");

  const homes = {
    config: undefined,
    dataDir,
    deviceHomes: { claude: join(parent, ".claude"), codex: join(parent, ".codex"), grok: join(parent, ".grok") },
  };

  const ledger = new SkillLedger(dataDir);
  const desired = create(AgentEnvironmentDesiredSchema);
  const root = join(homes.deviceHomes.claude, "skills");
  const name = "code-review";
  const path = join(root, name);
  mkdirSync(root, { recursive: true });

  const assign = () => {
    desired.skills = create(AgentEnvironmentDesiredSchema, {
      skills: [
        {
          id: Bun.randomUUIDv7(),
          version: 1n,
          harnesses: ["claude"],
          deviceHome: true,
          artifact: validateSkillFiles(skillFiles()),
        },
      ],
    }).skills;
  };

  const refresh = () => inventorySkills(desired, homes, ledger);

  const archive = (status: EnvironmentSkillStatus) => {
    desired.skillResolutions = [
      create(EnvironmentResolutionSchema, {
        targetId: status.targetId,
        action: "archive",
        observedChecksum: status.archiveToken,
        desiredChecksum: status.desiredChecksum,
      }),
    ];

    return refresh();
  };

  const recovery = (status: EnvironmentSkillStatus) =>
    join(dirname(dirname(status.path)), ".canopy-skill-archive", status.archiveToken, basename(status.path));

  const add = (folder = path) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "private local document");
  };

  return { parent, homes, ledger, desired, root, path, name, assign, refresh, archive, add, recovery };
}

describe("device skill inventory", () => {
  test("missing CLI homes count as empty roots and assigned skills create their destinations", () => {
    const f = fixture();
    rmSync(f.homes.deviceHomes.claude, { recursive: true });
    expect(f.refresh()).toEqual({ skills: [], scanned: true });
    f.assign();
    f.desired.skills[0]!.harnesses = ["claude", "codex", "grok"];

    const report = f.refresh();
    expect(report.scanned).toBe(true);
    expect(report.skills.map((skill) => skill.status)).toEqual(["applied", "applied", "applied"]);

    for (const skill of report.skills) expect(existsSync(join(skill.path, "SKILL.md"))).toBe(true);
  });

  test("lists independent device entries and archives only the selected snapshot", () => {
    const f = fixture();
    f.add();
    const other = join(f.homes.deviceHomes.codex, "skills", f.name);
    f.add(other);
    f.add(join(f.root, ".system"));
    mkdirSync(join(f.root, "not-a-skill"));
    writeFileSync(join(f.path, "notes"), "private attachment");
    const inventory = f.refresh();
    expect(inventory.scanned).toBe(true);
    expect(inventory.skills.map((s) => s.path).sort()).toEqual([f.path, other].sort());
    const local = inventory.skills.find((s) => s.path === f.path)!;
    expect(local).toMatchObject({
      status: "local",
      skillId: "",
      scope: "device",
      harness: "claude",
      localName: f.name,
      targetId: environmentDigest(`skill:${f.path}`),
      managedFiles: [],
      desiredFiles: [],
    });
    expect(toJsonString(EnvironmentSkillStatusSchema, local)).not.toContain("private ");
    writeFileSync(join(f.path, "notes"), "changed attachment");
    const stale = f.archive(local).skills.find((s) => s.path === f.path)!;
    expect(stale.detail).toContain("changed");
    expect(stale.archiveToken).not.toBe(local.archiveToken);
    expect(f.archive(stale).skills.map((s) => s.path)).toEqual([other]);
    expect(readFileSync(join(f.recovery(stale), "notes"), "utf8")).toBe("changed attachment");
    f.add();
    expect(f.archive(stale).skills.find((s) => s.path === f.path)?.status).toBe("error");
    expect(existsSync(join(f.path, "SKILL.md"))).toBe(true);
  });

  test("moves the symlink entry, including a dangling link, then installs the assigned library copy", () => {
    const f = fixture();
    const outside = join(f.parent, "private");
    f.add(outside);
    symlinkSync(outside, f.path, "dir");
    f.assign();
    const conflict = f.refresh().skills[0]!;
    expect(conflict).toMatchObject({ status: "error", localName: f.name, owned: false, localLink: true });
    const archive = f.recovery(conflict);
    expect(f.archive(conflict).skills[0]).toMatchObject({ status: "applied", owned: true, archiveToken: "" });
    expect(lstatSync(archive).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("private local document");
    expect(f.archive(conflict).skills[0]?.status).toBe("applied");
    expect(readFileSync(join(f.path, "SKILL.md"), "utf8")).toContain("Review the patch");
    const link = join(f.root, "missing");
    symlinkSync(join(f.parent, "missing"), link, "dir");
    const dangling = f.refresh().skills.find((s) => s.path === link)!;
    expect(dangling.status).toBe("local");
    f.archive(dangling);
    expect(lstatSync(f.recovery(dangling)).isSymbolicLink()).toBe(true);
  });

  test("refuses changed assignments, unsafe roots and a substituted archive directory", () => {
    const f = fixture();
    f.add();
    const local = f.refresh().skills[0]!;
    f.assign();
    expect(f.archive(local).skills[0]?.detail).toContain("assignment changed");
    f.desired.skillResolutions = [];
    const assigned = f.refresh().skills[0]!;
    const external = join(f.parent, "external");
    mkdirSync(external);
    symlinkSync(external, join(dirname(f.root), ".canopy-skill-archive"), "dir");
    expect(f.archive(assigned).skills[0]?.status).toBe("error");
    expect(existsSync(f.path)).toBe(true);
    renameSync(f.root, join(external, "original"));
    symlinkSync(join(external, "original"), f.root, "dir");
    const incomplete = f.archive(assigned);
    expect(incomplete.scanned).toBe(false);
    expect(incomplete.skills[0]?.archiveToken).toBe("");
    expect(readFileSync(join(external, "original", f.name, "SKILL.md"), "utf8")).toBe("private local document");
  });

  test("migrates a previous keep decision, then reports it as a standalone copy when unassigned", () => {
    const f = fixture();
    f.add();
    f.assign();
    const target = skillTargets(f.desired, f.homes, f.ledger)[0]!;
    const old = reconcileSkill(target, f.ledger);
    expect(
      reconcileSkill(
        target,
        f.ledger,
        create(EnvironmentResolutionSchema, {
          action: "keep",
          observedChecksum: old.observedChecksum,
          desiredChecksum: old.desiredChecksum,
        }),
      ).status,
    ).toBe("kept");
    expect(f.refresh().skills[0]?.status).toBe("kept");
    f.desired.skills = [];
    const unassigned = f.refresh().skills[0]!;
    expect(unassigned).toMatchObject({ status: "local", skillId: "", desiredChecksum: "", version: 0n });
    expect(f.ledger.entries.size).toBe(0);
    expect(f.archive(unassigned).skills).toEqual([]);
  });

  test("preserves an entry replaced during the move without overwriting a concurrent recreation", () => {
    const f = fixture();
    f.add();
    const local = f.refresh().skills[0]!;
    withSkillDirectory(dirname(f.root), (home) => {
      const root = home.child(basename(f.root));

      try {
        const racingRoot = {
          ...root,
          move(name: string, destination: typeof root) {
            renameSync(f.path, join(f.parent, "original"));
            f.add();
            writeFileSync(join(f.path, "SKILL.md"), "substituted");
            root.move(name, destination);
            f.add();
            writeFileSync(join(f.path, "SKILL.md"), "recreated");
          },
        };

        expect(() => archiveSkillCopy(home, racingRoot, f.name, local.targetId, local.archiveToken)).toThrow(
          "Recover it from",
        );
      } finally {
        root.close();
      }
    });
    expect(readFileSync(join(f.path, "SKILL.md"), "utf8")).toBe("recreated");
    expect(readFileSync(join(f.recovery(local), "SKILL.md"), "utf8")).toBe("substituted");
  });

  test("reports a failed archive when the previously listed standalone root becomes a symlink", () => {
    const f = fixture();
    f.add();
    let result = create(AgentEnvironmentReportSchema);

    const environment = new WorkerAgentEnvironment({
      homes: () => f.homes,
      send: (report) => {
        result = report;
      },
    });

    try {
      environment.apply(f.desired);
      expect(result.skillInventoryScanned).toBe(true);
      const local = result.skills[0]!;
      renameSync(f.root, join(f.parent, "elsewhere"));
      symlinkSync(join(f.parent, "elsewhere"), f.root, "dir");
      f.desired.skillResolutions = [
        create(EnvironmentResolutionSchema, {
          targetId: local.targetId,
          action: "archive",
          observedChecksum: local.archiveToken,
        }),
      ];
      environment.apply(f.desired);
      expect(result.skillInventoryScanned).toBe(false);
      expect(result.skills[0]).toMatchObject({ targetId: local.targetId, status: "error", archiveToken: "" });
      expect(result.skills[0]?.detail).toContain("Couldn't move");
      expect(existsSync(join(f.parent, "elsewhere", f.name, "SKILL.md"))).toBe(true);
    } finally {
      environment.stop();
    }
  });

  test("an unreadable ownership ledger and interrupted installation disable archival", () => {
    const f = fixture();
    f.add();
    const targetId = environmentDigest(`skill:${f.path}`);
    const journal = join(f.root, `.canopy-${targetId}-transaction.json`);
    writeFileSync(journal, "{}");
    expect(f.refresh().skills[0]?.archiveToken).toBe("");
    rmSync(journal);
    f.ledger.problem = "The ownership ledger is unreadable.";
    expect(f.refresh().skills[0]?.archiveToken).toBe("");
    expect(existsSync(f.path)).toBe(true);
  });
});
