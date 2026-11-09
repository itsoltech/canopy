import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clone, create, toJson } from "@bufbuild/protobuf";
import { AgentEnvironmentReportSchema, SkillFileSchema, ui, type EnvironmentSkillStatus } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { librarySkill, skillFiles, skillMachine, writeUserSkill, zipSkill } from "./support/agent-skills.ts";

const root = tempDir("canopy-agent-skills-");
let gateway: Awaited<ReturnType<typeof startTestGateway>>;

type Machine = Awaited<ReturnType<typeof skillMachine>>;

const machines: Machine[] = [];
let linux: Machine;
let windows: Machine;
let old: Machine;
const snapshot = () => gateway.api.getAgentEnvironment({});

beforeAll(async () => {
  gateway = await startTestGateway();
  linux = await skillMachine(gateway, root, "linux");
  machines.push(linux);
  windows = await skillMachine(gateway, root, "windows", "win32");
  machines.push(windows);
  old = await skillMachine(gateway, root, "older", "linux", false);
  machines.push(old);

  // The older worker also registers environment facts and bumps the shared revision.
  const state = await eventually(snapshot, (s) =>
    machines.every((machine) =>
      s.workers.some((w) => w.workerId === machine.workerId && w.supported && w.report?.revision === s.revision),
    ),
  );

  expect(state.workers.filter((w) => w.skillsSupported)).toHaveLength(2);

  for (const machine of machines) {
    const worker = state.workers.find((w) => w.workerId === machine.workerId)!;
    expect(worker.supported).toBe(true);
    expect(worker.report?.revision).toBe(state.revision);
  }
}, 60_000);

afterAll(async () => {
  for (const machine of machines) {
    machine.link.close();
    await machine.serving;
    await machine.host.close();
    await machine.runtime.dispose();
  }

  if (gateway) await gateway.close();
});

async function save(skill: ui.LibrarySkill, files = skillFiles(), zip = new Uint8Array()) {
  return gateway.api.saveLibrarySkill({ skill, files, zip, expectedRevision: (await snapshot()).revision });
}

async function settled(machine = linux) {
  const state = await eventually(
    snapshot,
    (s) => s.workers.find((w) => w.workerId === machine.workerId)?.report?.revision === s.revision,
  );

  const worker = state.workers.find((w) => w.workerId === machine.workerId)!;
  expect(worker.report?.revision).toBe(state.revision);

  return worker;
}

async function drift(path: string, text: string) {
  writeFileSync(path, text);
  linux.host.environment.refresh(true);

  const state = await eventually(
    snapshot,
    (s) =>
      s.workers
        .find((w) => w.workerId === linux.workerId)
        ?.report?.skills.some((f) => f.path === join(path, "..") && f.status === "drift") ?? false,
  );

  const file = state.workers
    .find((w) => w.workerId === linux.workerId)!
    .report!.skills.find((f) => f.path === join(path, ".."))!;

  expect(file.status).toBe("drift");

  return file;
}

async function resolve(file: EnvironmentSkillStatus, action: string) {
  return gateway.api.resolveSkillDrift({
    workerId: linux.workerId,
    targetId: file.targetId,
    action,
    observedChecksum: file.observedChecksum,
    expectedRevision: (await snapshot()).revision,
  });
}

describe("versioned skills across the gateway and actual worker homes", () => {
  test("folder/ZIP boundaries reject traversal, links, collisions, size, file count and invalid SKILL.md without writes", async () => {
    const before = await snapshot();

    const badPaths = [
      "../outside",
      "/absolute",
      "C:/escape",
      "x/../../escape",
      "x\\escape",
      "x/CON.txt",
      "x./SKILL.md",
    ];

    for (const path of badPaths) {
      expect(
        await failure(
          save(librarySkill(), [...skillFiles(), create(SkillFileSchema, { path, content: Buffer.from("bad") })]),
        ),
      ).toContain("paths");
      expect(await failure(save(librarySkill(), [], zipSkill([{ path, content: Buffer.from("bad") }])))).toContain(
        "paths",
      );
    }

    for (const mode of [0o120777, 0o020600, 0o010600]) {
      expect(
        await failure(
          save(librarySkill(), [], zipSkill([{ path: "SKILL.md", content: Buffer.from("/outside"), mode }])),
        ),
      ).toContain("Symlinks");
    }

    expect(await failure(save(librarySkill(), skillFiles("con")))).toContain("reserved names");

    expect(
      await failure(save(librarySkill(), [...skillFiles(), create(SkillFileSchema, { path: "skill.md" })])),
    ).toContain("case-colliding");
    expect(
      await failure(save(librarySkill(), [...skillFiles(), create(SkillFileSchema, { path: "Scripts/other.sh" })])),
    ).toContain("case-colliding");
    expect(
      await failure(
        save(
          librarySkill(),
          [],
          zipSkill(Array.from({ length: 26 }, (_, i) => ({ path: `large-${i}`, content: Buffer.alloc(1024 * 1024) }))),
        ),
      ),
    ).toContain("size limits");
    expect(
      await failure(
        save(librarySkill(), [create(SkillFileSchema, { path: "SKILL.md", content: Buffer.from("no metadata") })]),
      ),
    ).toContain("frontmatter");
    expect(
      await failure(
        save(librarySkill(), [
          ...skillFiles(),
          create(SkillFileSchema, { path: "huge", content: Buffer.alloc(1024 * 1024 + 1) }),
        ]),
      ),
    ).toContain("1 MiB");
    expect(
      await failure(save(librarySkill(), [], zipSkill([{ path: "huge", content: Buffer.alloc(1024 * 1024 + 1) }]))),
    ).toContain("size limits");
    expect(
      await failure(
        save(
          librarySkill(),
          Array.from({ length: 1001 }, (_, i) => create(SkillFileSchema, { path: `file-${i}` })),
        ),
      ),
    ).toContain("1000");
    expect(await failure(save(librarySkill(), [], Buffer.alloc(10 * 1024 * 1024 + 1)))).toContain("10 MiB");
    expect((await snapshot()).revision).toBe(before.revision);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });

  test("installs validated ZIP into Claude, Codex .agents, Grok, shared platform and instance homes", async () => {
    writeUserSkill(join(linux.deviceHomes.agents, "personal"));

    const state = await save(
      librarySkill(),
      [],
      zipSkill(
        skillFiles().map((file) => ({
          path: `code-review/${file.path}`,
          content: file.content,
          mode: file.executable ? 0o100755 : 0o100644,
        })),
      ),
    );

    const skill = state.skills[0]!;
    expect(skill.version).toBe(1n);
    expect(skill.artifact?.files.every((f) => f.checksum.length === 64)).toBe(true);
    const worker = await settled();
    expect(worker.report?.skills.length).toBeGreaterThanOrEqual(8);
    expect(worker.report?.skills.every((f) => f.status === "applied")).toBe(true);

    for (const path of [
      join(linux.deviceHomes.claude, "skills/code-review"),
      join(linux.deviceHomes.agents, "code-review"),
      join(linux.deviceHomes.grok, "skills/code-review"),
      join(linux.dataDir, "claude-home/canopy-environment/skills/code-review"),
      join(linux.dataDir, "codex-home/skills/code-review"),
      join(linux.dataDir, "grok-home/skills/code-review"),
      join(linux.shadow, "canopy-environment/skills/code-review"),
      join(linux.shadow, "skills/code-review"),
    ])
      expect(readFileSync(join(path, "SKILL.md"), "utf8")).toContain("Review the patch carefully.");
    expect(existsSync(join(linux.deviceHomes.codex, "skills/code-review"))).toBe(false);
    expect(existsSync(join(old.deviceHomes.agents, "code-review"))).toBe(false);
    expect((await snapshot()).workers.find((w) => w.workerId === old.workerId)?.skillsSupported).toBe(false);
    expect(
      (
        await gateway.core.link.connections
          .get(old.workerId)!
          .sendCommand({ case: "listDirectory", value: { path: root } })
      ).ok,
    ).toBe(true);
  });

  test("tags exclude Windows-only skills from Linux; explicit disable and version overrides are honored", async () => {
    const skill = librarySkill();
    skill.name = "Windows tools";
    skill.selector = create(ui.EnvironmentSelectorSchema, { tags: ["os:windows"] });
    const result = await save(skill, skillFiles("windows-tools", "Use PowerShell."));
    const id = result.skills.find((s) => s.name === "Windows tools")!.id;
    await settled(windows);
    await settled();
    expect(existsSync(join(windows.deviceHomes.agents, "windows-tools/SKILL.md"))).toBe(true);
    expect(existsSync(join(linux.deviceHomes.agents, "windows-tools"))).toBe(false);

    const original = clone(
      ui.LibrarySkillSchema,
      result.skills.find((s) => s.id === id)!,
    );

    original.overrides = [create(ui.SkillMachineOverrideSchema, { workerId: windows.workerId, disabled: true })];
    await save(original, []);
    await settled(windows);
    expect(existsSync(join(windows.deviceHomes.agents, "windows-tools/SKILL.md"))).toBe(false);
  });

  test("new versions, rollback and per-machine pins preserve additional local files", async () => {
    const skill = clone(
      ui.LibrarySkillSchema,
      (await snapshot()).skills.find((s) => s.artifact?.name === "code-review")!,
    );

    const extra = join(linux.deviceHomes.agents, "code-review/private.txt");
    writeFileSync(extra, "Private extra file. Never send it to the gateway.");
    skill.overrides = [create(ui.SkillMachineOverrideSchema, { workerId: windows.workerId, version: 1n })];
    const saved = await save(skill, skillFiles("code-review", "Version two."));
    expect(saved.skills.find((s) => s.id === skill.id)?.versions).toEqual([1n, 2n]);
    const preview = await gateway.api.getAgentEnvironment({ previewSkillId: skill.id, previewSkillVersion: 1n });
    expect(
      new TextDecoder().decode(preview.previewSkillArtifact?.files.find((file) => file.path === "SKILL.md")?.content),
    ).toContain("Review the patch carefully.");
    expect(preview.skills.find((s) => s.id === skill.id)?.version).toBe(2n);
    expect(preview.revision).toBe(saved.revision);
    expect((await snapshot()).skills.find((s) => s.id === skill.id)?.version).toBe(2n);
    expect(
      await failure(gateway.api.getAgentEnvironment({ previewSkillId: skill.id, previewSkillVersion: 999n })),
    ).toContain("version not found");
    await settled();
    await settled(windows);
    expect(readFileSync(join(linux.deviceHomes.agents, "code-review/SKILL.md"), "utf8")).toContain("Version two.");
    expect(readFileSync(join(windows.deviceHomes.agents, "code-review/SKILL.md"), "utf8")).toContain(
      "Review the patch carefully.",
    );
    expect(readFileSync(extra, "utf8")).toContain("Private extra");

    const rollback = clone(
      ui.LibrarySkillSchema,
      saved.skills.find((s) => s.id === skill.id)!,
    );

    rollback.version = 1n;
    await save(rollback, []);
    await settled();
    expect(readFileSync(join(linux.deviceHomes.agents, "code-review/SKILL.md"), "utf8")).toContain(
      "Review the patch carefully.",
    );
    expect(JSON.stringify(toJson(AgentEnvironmentReportSchema, (await settled()).report!))).not.toContain(
      "Private extra",
    );
  });

  test("drift compares owned files; keep, stale CAS, overwrite and import never expose private additions", async () => {
    const path = join(linux.deviceHomes.agents, "code-review/SKILL.md");
    const original = readFileSync(path, "utf8");
    const file = await drift(path, original.replace("Review the patch carefully.", "My local review."));
    expect(file.importable).toBe(true);
    expect(file.managedFiles.map((f) => f.path)).toEqual(expect.arrayContaining(["SKILL.md", "scripts/check.sh"]));
    expect(file.managedFiles.some((f) => f.path === "private.txt")).toBe(false);
    await resolve(file, "keep");
    expect((await settled()).report?.skills.find((f) => f.targetId === file.targetId)?.status).toBe("kept");
    const stale = (await settled()).report!.skills.find((f) => f.targetId === file.targetId)!;
    writeFileSync(path, original.replace("Review the patch carefully.", "New edit after preview."));
    await resolve(stale, "overwrite");
    expect((await settled()).report?.skills.find((f) => f.targetId === file.targetId)?.status).toBe("drift");
    expect(readFileSync(path, "utf8")).toContain("New edit after preview.");
    const current = (await settled()).report!.skills.find((f) => f.targetId === file.targetId)!;
    await resolve(current, "overwrite");
    await settled();
    expect(readFileSync(path, "utf8")).toBe(original);
    const imported = await drift(path, original.replace("Review the patch carefully.", "Imported locally."));
    const state = await resolve(imported, "import");
    await settled();
    await settled(windows);
    const skill = state.skills.find((s) => s.id === file.skillId)!;
    expect(skill.version).toBe(1n);
    expect(skill.versions).toEqual([1n, 2n, 3n]);
    expect(skill.overrides.find((o) => o.workerId === linux.workerId)?.version).toBe(3n);
    expect(readFileSync(path, "utf8")).toContain("Imported locally.");
    expect(readFileSync(join(windows.deviceHomes.agents, "code-review/SKILL.md"), "utf8")).not.toContain(
      "Imported locally.",
    );
    // An overwrite is consumed once, even if the old local content reappears.
    await drift(path, original.replace("Review the patch carefully.", "New edit after preview."));
    await gateway.core.environment.sync(linux.workerId);
    await settled();
    expect((await settled()).report?.skills.find((f) => f.targetId === file.targetId)?.status).toBe("drift");
    const latest = (await settled()).report!.skills.find((f) => f.targetId === file.targetId)!;
    await resolve(latest, "overwrite");
    await settled();
  });

  test("offline catch-up installs only the latest version and removal leaves user-owned skills and extra files", async () => {
    linux.link.close();
    await linux.serving;

    const skill = clone(
      ui.LibrarySkillSchema,
      (await snapshot()).skills.find((s) => s.artifact?.name === "code-review")!,
    );

    skill.overrides = skill.overrides.filter((o) => o.workerId !== linux.workerId);
    await save(skill, skillFiles("code-review", "Offline update."));
    Object.assign(linux, await linux.connect());
    await settled();
    expect(readFileSync(join(linux.deviceHomes.agents, "code-review/SKILL.md"), "utf8")).toContain("Offline update.");
    const state = await snapshot();
    await gateway.api.deleteLibrarySkill({ id: skill.id, expectedRevision: state.revision });
    await settled();
    expect(existsSync(join(linux.deviceHomes.agents, "code-review/SKILL.md"))).toBe(false);
    expect(readFileSync(join(linux.deviceHomes.agents, "code-review/private.txt"), "utf8")).toContain("Private extra");
    expect(readFileSync(join(linux.deviceHomes.agents, "personal/SKILL.md"), "utf8")).toContain("Private user skill");
  });

  test("existing folders and symlink destinations cannot be adopted, and status never includes user content", async () => {
    writeUserSkill(join(linux.deviceHomes.agents, "occupied"));
    const state = await save(librarySkill(), skillFiles("occupied"));
    const status = (await settled()).report!.skills.find((f) => f.path === join(linux.deviceHomes.agents, "occupied"))!;
    expect(status.status).toBe("drift");
    expect(status.managedFiles).toEqual([]);
    expect(status.importable).toBe(false);
    await resolve(status, "overwrite");
    await settled();
    expect(readFileSync(join(linux.deviceHomes.agents, "occupied/SKILL.md"), "utf8")).toContain("Private user skill");
    const link = join(linux.deviceHomes.agents, "linked");
    symlinkSync(join(linux.deviceHomes.agents, "personal"), link);
    await save(librarySkill(), skillFiles("linked"));
    expect((await settled()).report?.skills.find((f) => f.path === link)?.status).toBe("error");
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("Private user skill");
    expect(state.skills.length).toBeGreaterThan(0);
  });

  test("removing a locally edited skill waits for a fresh decision and preserves user additions", async () => {
    const created = await save(librarySkill(), skillFiles("remove-edited"));
    const skill = created.skills.find((s) => s.artifact?.name === "remove-edited")!;
    await settled();
    const path = join(linux.deviceHomes.agents, "remove-edited/SKILL.md");

    const file = await drift(
      path,
      readFileSync(path, "utf8").replace("Review the patch carefully.", "Keep until resolved."),
    );

    writeFileSync(join(path, "../private.txt"), "Private addition.");
    await gateway.api.deleteLibrarySkill({ id: skill.id, expectedRevision: (await snapshot()).revision });
    const worker = await settled();
    const removed = worker.report!.skills.find((s) => s.targetId === file.targetId)!;
    expect(removed.status).toBe("drift");
    expect(readFileSync(path, "utf8")).toContain("Keep until resolved.");
    await resolve(removed, "overwrite");
    expect((await settled()).report?.skills.find((s) => s.targetId === file.targetId)?.status).toBe("removed");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(path, "../private.txt"), "utf8")).toBe("Private addition.");
  });

  test("foreign owners cannot read artifacts, change assignments, reuse versions or resolve another worker", async () => {
    const owner = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("skills-other@localhost", "Other")),
    );

    const foreign = new AgentEnvironment({
      runtime: gateway.runtime,
      userId: owner,
      link: gateway.core.link,
      changed: () => {},
    });

    const created = await foreign.skills.save(
      create(ui.SaveLibrarySkillRequestSchema, { skill: librarySkill(), files: skillFiles("foreign") }),
    );

    const id = created.skills[0]!.id;
    const state = await snapshot();
    expect(state.skills.some((s) => s.id === id)).toBe(false);
    expect(await failure(gateway.api.getAgentEnvironment({ previewSkillId: id, previewSkillVersion: 1n }))).toContain(
      "not found",
    );
    expect(await failure(gateway.api.getAgentEnvironment({ previewSkillVersion: 1n }))).toContain("Choose a skill");
    expect(await failure(gateway.api.deleteLibrarySkill({ id, expectedRevision: state.revision }))).toContain(
      "not found",
    );
    const skill = librarySkill();
    skill.id = id;
    expect(await failure(save(skill))).toContain("not found");
    expect(
      await failure(
        foreign.skills.resolve(
          create(ui.ResolveSkillDriftRequestSchema, {
            workerId: linux.workerId,
            action: "overwrite",
            expectedRevision: created.revision,
          }),
        ),
      ),
    ).toContain("not found");
    const own = clone(ui.LibrarySkillSchema, state.skills[0]!);
    own.version = 999n;
    expect(await failure(save(own, []))).toContain("version not found");
    expect((await foreign.snapshot()).skills[0]?.artifact?.name).toBe("foreign");
  });
});
