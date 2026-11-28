import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@canopy/testing";
import { claudeSkillPlugins } from "../../apps/worker/src/providers/claude/skill-plugin.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { librarySkill, skillFiles, skillMachine, writeUserSkill } from "./support/agent-skills.ts";

const root = tempDir("canopy-grouped-skills-");
let gateway: Awaited<ReturnType<typeof startTestGateway>>;
let machine: Awaited<ReturnType<typeof skillMachine>>;

beforeAll(async () => {
  gateway = await startTestGateway();
  machine = await skillMachine(gateway, root, "local");
}, 60_000);

afterAll(async () => {
  if (machine) {
    machine.link.close();
    await machine.serving;
    await machine.host.close();
    await machine.runtime.dispose();
  }

  if (gateway) await gateway.close();
});

test("claims only the reviewed skill copies together and preserves a copy edited before its individual move", async () => {
  const read = () => gateway.api.getWorkerEnvironment({ workerId: machine.workerId });
  const current = await eventually(read, (s) => Boolean(s.worker?.skillReportId));
  const name = "grouped-skill";
  const claude = join(machine.dataDir, "claude-home");
  const platform = join(claude, "canopy-environment", "skills", name);
  const device = join(machine.deviceHomes.claude, "skills", name);
  const changed = join(machine.dataDir, "grok-home", "skills", name);
  const other = join(machine.dataDir, "codex-home", "skills", name);
  const custom = join(machine.shadow, "skills", name);

  for (const path of [platform, device, changed, other, custom]) writeUserSkill(path);
  const local = readFileSync(join(device, "SKILL.md"));
  const files = skillFiles(name);

  const saved = await gateway.api.saveLibrarySkill({
    expectedRevision: current.revision,
    skill: librarySkill(),
    files,
  });

  const first = await eventually(read, (s) => s.worker?.report?.revision === saved.revision);
  expect(first.worker?.skillReportId).toBeTruthy();
  const before = first.worker!.skillReportId;
  machine.host.environment.refresh(true);
  const state = await eventually(read, (s) => Boolean(s.worker?.skillReportId && s.worker.skillReportId !== before));
  const report = state.worker!.report!;

  const targets = [platform, device, changed].map((path) => {
    const copy = report.skills.find((f) => f.path === path)!;
    expect(copy.archiveToken).toHaveLength(64);

    return { targetId: copy.targetId, archiveToken: copy.archiveToken };
  });

  expect(report.skills.find((f) => f.path === other)?.archiveToken).toHaveLength(64);
  expect(report.skills.find((f) => f.path === custom)).toMatchObject({ archiveToken: "", status: "drift" });

  const request = {
    workerId: machine.workerId,
    skillId: saved.skills[0]!.id,
    expectedRevision: state.revision,
    reportId: state.worker!.skillReportId,
    targets,
  };

  const use = (changes: Partial<typeof request> = {}) => gateway.api.useLibrarySkillVersion({ ...request, ...changes });
  await expect(use({ reportId: before })).rejects.toThrow(/changed/i);
  await expect(use({ expectedRevision: request.expectedRevision - 1n })).rejects.toThrow(/changed/i);
  await expect(use({ skillId: Bun.randomUUIDv7() })).rejects.toThrow(/changed/i);
  await expect(use({ targets: [targets[0]!, targets[0]!] })).rejects.toThrow(/changed/i);
  await expect(use({ targets: [targets[0]!, { ...targets[1]!, archiveToken: "a".repeat(64) }] })).rejects.toThrow(
    /changed/i,
  );
  expect((await read()).worker?.report?.skills.find((f) => f.path === platform)?.archiveToken).toBe(
    targets[0]!.archiveToken,
  );
  writeFileSync(join(changed, "SKILL.md"), "Edited after the review.");

  const claims = await Promise.allSettled([use(), use()]);
  expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);

  const outcome = await eventually(
    read,
    (s) => s.worker?.report?.skills.find((f) => f.path === device)?.status === "applied",
  );

  expect(outcome.revision).toBe(state.revision);
  expect(outcome.worker?.report?.skills.find((f) => f.path === platform)).toMatchObject({
    status: "applied",
    owned: true,
  });
  expect(outcome.worker?.report?.skills.find((f) => f.path === changed)?.detail).toContain("changed");
  expect(readFileSync(join(changed, "SKILL.md"), "utf8")).toBe("Edited after the review.");
  expect(readFileSync(join(other, "SKILL.md"))).toEqual(local);
  expect(readFileSync(join(custom, "SKILL.md"))).toEqual(local);

  for (const [index, path] of [platform, device].entries()) {
    expect(readFileSync(join(path, "SKILL.md"))).toEqual(Buffer.from(files[0]!.content));
    const home = path === platform ? claude : dirname(dirname(path));
    expect(readFileSync(join(home, ".canopy-skill-archive", targets[index]!.archiveToken, name, "SKILL.md"))).toEqual(
      local,
    );
  }

  expect(claudeSkillPlugins(claude)).toHaveLength(1);
});

test("previews an assigned device folder explicitly and installs its pinned version after saving the reviewed files", async () => {
  const read = () => gateway.api.getWorkerEnvironment({ workerId: machine.workerId });
  const name = "assigned-import";
  const path = join(machine.deviceHomes.claude, "skills", name);
  const contents = skillFiles(name, "Reviewed device copy.");
  const library = skillFiles(name, "Previous library content.");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), contents[0]!.content);
  const skill = librarySkill();
  skill.harnesses = ["claude"];
  skill.overrides = [create(ui.SkillMachineOverrideSchema, { workerId: machine.workerId, version: 1n })];

  const added = await gateway.api.saveLibrarySkill({
    skill,
    files: library,
    expectedRevision: (await read()).revision,
  });

  const entry = added.skills.find((s) => s.artifact?.name === name)!;
  const state = await eventually(read, (s) => s.worker?.report?.revision === added.revision);
  expect(state.worker?.conflictSkillImportSupported).toBe(true);
  const local = state.worker!.report!.skills.find((f) => f.path === path)!;
  expect(local).toMatchObject({ status: "drift", skillId: entry.id, scope: "device", owned: false, managedFiles: [] });

  const request = {
    workerId: machine.workerId,
    targetId: local.targetId,
    archiveToken: local.archiveToken,
    expectedRevision: state.revision,
    skillId: entry.id,
  };

  await expect(gateway.api.previewWorkerSkill({ ...request, skillId: "" })).rejects.toThrow(/changed/i);
  await expect(gateway.api.previewWorkerSkill({ ...request, skillId: Bun.randomUUIDv7() })).rejects.toThrow(/changed/i);
  const preview = await gateway.api.previewWorkerSkill(request);
  expect(preview.artifact?.files.map((f) => [f.path, Buffer.from(f.content)])).toEqual([
    ["SKILL.md", Buffer.from(contents[0]!.content)],
  ]);

  const saved = await gateway.api.saveLibrarySkill({
    skill: { ...entry, artifact: undefined },
    files: preview.artifact!.files,
    expectedRevision: state.revision,
  });

  const updated = saved.skills.find((s) => s.id === entry.id)!;
  expect(updated.version).toBe(2n);
  expect(updated.overrides).toEqual(entry.overrides);
  expect(updated.selector).toEqual(entry.selector);
  expect(updated.artifact?.files[0]?.content).toEqual(contents[0]!.content);
  const next = await eventually(read, (s) => s.worker?.report?.revision === saved.revision && !!s.worker.skillReportId);
  const source = next.worker!.report!.skills.find((f) => f.path === path)!;
  expect(source).toMatchObject({
    version: 1n,
    archiveToken: local.archiveToken,
    desiredChecksum: entry.artifact!.checksum,
  });
  expect(readFileSync(join(path, "SKILL.md"))).toEqual(Buffer.from(contents[0]!.content));
  await gateway.api.useLibrarySkillVersion({
    workerId: machine.workerId,
    skillId: entry.id,
    expectedRevision: next.revision,
    reportId: next.worker!.skillReportId,
    targets: [{ targetId: source.targetId, archiveToken: local.archiveToken }],
  });

  const installed = await eventually(
    read,
    (s) => s.worker?.report?.skills.some((f) => f.path === path && f.owned) ?? false,
  );

  expect(installed.worker?.report?.skills.find((f) => f.path === path)).toMatchObject({
    status: "applied",
    owned: true,
    version: 1n,
  });
  expect(readFileSync(join(path, "SKILL.md"))).toEqual(Buffer.from(library[0]!.content));
  expect(
    readFileSync(join(machine.deviceHomes.claude, ".canopy-skill-archive", local.archiveToken, name, "SKILL.md")),
  ).toEqual(Buffer.from(contents[0]!.content));
});
