import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui, WorkerEnrollmentService } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { WorkerAdministration } from "../../apps/gateway/src/core/worker-administration.ts";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { librarySkill, skillFiles, skillMachine } from "./support/agent-skills.ts";
import { sourceRepository } from "./support/skill-sources.ts";

const root = tempDir("canopy-worker-tags-");
const repo = sourceRepository(root, "market");
let gateway: Awaited<ReturnType<typeof startTestGateway>>;
let machine: Awaited<ReturnType<typeof skillMachine>>;
let pluginId = "";
const snapshot = () => gateway.api.getAgentEnvironment({});
const selector = { tags: ["team", "os:linux"], matchAllTags: true, excludeTags: ["blocked"] };
const host = { hostname: "tagged-worker", os: "linux", arch: "x64" };

beforeAll(async () => {
  repo.file(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ name: "tag-market", plugins: [{ name: "review", source: "./plugins/review" }] }),
  );
  repo.file("plugins/review/.claude-plugin/plugin.json", JSON.stringify({ name: "review" }));
  repo.file("plugins/review/README.md", "Approved team plugin.");
  repo.commit();
  gateway = await startTestGateway({
    skillSources: { fixtureRepo: (url) => (url === "https://github.com/fixture/tags.git" ? repo.bare : undefined) },
  });
  await gateway.api.saveInstructionDocument({
    expectedRevision: (await snapshot()).revision,
    document: {
      name: "Team instructions",
      harness: "claude",
      platformHome: true,
      selector,
      fragments: [{ id: "team", content: "Use the team workflow." }],
    },
  });
  const skill = librarySkill();
  skill.selector = create(ui.EnvironmentSelectorSchema, selector);
  await gateway.api.saveLibrarySkill({ skill, files: skillFiles(), expectedRevision: (await snapshot()).revision });
  const preview = await gateway.api.previewMarketplace({ command: "/plugin marketplace add fixture/tags" });

  const saved = await gateway.api.saveMarketplace({
    previewId: preview.id,
    expectedRevision: (await snapshot()).revision,
  });

  const marketplace = saved.marketplaces[0]!;

  const enabled = await gateway.api.saveLibraryPlugin({
    marketplaceId: marketplace.id,
    pluginName: "review",
    assignment: { name: "Team plugin", harnesses: ["claude", "codex"], platformHome: true, selector },
    confirmedChecksum: marketplace.plugins[0]!.artifact!.checksum,
    expectedRevision: saved.revision,
  });

  pluginId = enabled.plugins[0]!.assignment!.id;
}, 60_000);

afterAll(async () => {
  if (machine) {
    machine.link.close();
    await machine.serving;
    await machine.host.close();
    await machine.runtime.dispose();
  }

  await gateway?.close();
});

async function settled() {
  const state = await eventually(snapshot, (s) =>
    s.workers.some((w) => w.workerId === machine.workerId && w.report?.revision === s.revision),
  );

  const worker = state.workers.find((w) => w.workerId === machine.workerId)!;
  expect(worker.report?.revision).toBe(state.revision);

  return worker;
}

const pluginPath = () => join(machine.shadow, "plugins/cache", `canopy-${pluginId}-claude`, "review/local/README.md");

describe("worker tags from enrollment through assignment reconcile", () => {
  test("server-stored enrollment tags are atomic and select instructions, skills and plugins on first connect", async () => {
    const invitation = await gateway.api.createWorkerEnrollment({
      name: host.hostname,
      tags: ["team", "build", "team"],
    });

    expect(invitation.token).toMatch(/^canopy_enroll_[A-Za-z0-9_-]{43}$/);
    const client = createClient(WorkerEnrollmentService, createGrpcTransport({ baseUrl: gateway.grpcUrl }));
    const enrolled = await client.enroll({ enrollmentToken: invitation.token, host });
    // Already committed before Hello; no client-side follow-up can race the first desired state.
    const initial = (await snapshot()).workers.find((w) => w.workerId === enrolled.workerId)!;
    expect(initial.manualTags).toEqual(["build", "team"]);
    expect(initial.automaticTags).toEqual([]);

    const records = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ tags: string[]; manual_tags: string[]; owner_user_id: string; used: boolean }>`
          SELECT e.tags, w.manual_tags, e.owner_user_id, e.used_at IS NOT NULL AS used
          FROM worker_enrollments e JOIN worker_environments w ON w.worker_id = e.worker_id
          WHERE e.id = ${invitation.enrollment!.id}::uuid`;
      }),
    );

    expect(records).toEqual([
      { tags: ["build", "team"], manual_tags: ["build", "team"], owner_user_id: gateway.userId, used: true },
    ]);
    machine = await skillMachine(gateway, root, host.hostname, "linux", true, {
      workerId: enrolled.workerId,
      credential: enrolled.workerCredential,
    });
    const worker = await settled();
    expect(worker.automaticTags).toContain("os:linux");
    expect(worker.manualTags).toEqual(["build", "team"]);
    expect(worker.preview.some((i) => i.content === "Use the team workflow.")).toBe(true);
    expect(readFileSync(join(machine.shadow, "CLAUDE.md"), "utf8")).toContain("Use the team workflow.");
    expect(existsSync(join(machine.shadow, "skills/code-review/SKILL.md"))).toBe(true);
    expect(readFileSync(pluginPath(), "utf8")).toBe("Approved team plugin.");
    expect(worker.report!.skills.every((s) => s.status === "applied")).toBe(true);
    expect(worker.report!.plugins.every((p) => p.status === "applied")).toBe(true);
  });

  test("per-worker edits reconcile include/exclude assignments, are audited and survive reconnect", async () => {
    await gateway.api.setEnvironmentTags({
      workerId: machine.workerId,
      tags: ["team", "blocked"],
      expectedRevision: (await snapshot()).revision,
    });
    const excluded = await settled();
    expect(excluded.skillIds).toEqual([]);
    expect(excluded.pluginIds).toEqual([]);
    expect(excluded.preview.every((i) => !i.content)).toBe(true);
    expect(existsSync(join(machine.shadow, "skills/code-review/SKILL.md"))).toBe(false);
    expect(existsSync(pluginPath())).toBe(false);
    await gateway.api.setEnvironmentTags({
      workerId: machine.workerId,
      tags: ["team"],
      expectedRevision: (await snapshot()).revision,
    });
    await settled();
    machine.link.close();
    await machine.serving;
    Object.assign(machine, await machine.connect());
    const restored = await settled();
    expect(restored.manualTags).toEqual(["team"]);
    expect(restored.skillIds).toHaveLength(1);
    expect(restored.pluginIds).toEqual([pluginId]);
    expect(readFileSync(pluginPath(), "utf8")).toBe("Approved team plugin.");

    const audits = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT id FROM audit_log WHERE actor_user_id = ${gateway.userId}::uuid
          AND target_id = ${machine.workerId}::uuid AND action = 'environment.tags.save'`;
      }),
    );

    expect(audits).toHaveLength(3);
  });

  test("invalid tags, foreign workers and enrollment IDs cannot change another owner's state", async () => {
    for (const tags of [["os:linux"], ["Uppercase"], Array.from({ length: 33 }, (_, i) => `tag-${i}`)])
      expect(await failure(gateway.api.createWorkerEnrollment({ name: "Invalid", tags }))).toContain("tags");

    const otherId = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("tags-other@localhost", "Other")),
    );

    const other = new WorkerAdministration({ ...gateway.core.workers.options, userId: otherId });
    const foreign = new AgentEnvironment({ ...gateway.core.environment.options, userId: otherId });
    const invitation = await other.create("Other owner's worker", ["private"]);
    expect((await gateway.api.getWorkerSetup({})).enrollments.some((e) => e.id === invitation.enrollment!.id)).toBe(
      false,
    );
    expect(await failure(gateway.api.revokeWorkerEnrollment({ id: invitation.enrollment!.id }))).toContain("not found");
    expect(
      await failure(
        gateway.api.setEnvironmentTags({
          workerId: invitation.enrollment!.id,
          tags: ["stolen"],
          expectedRevision: (await snapshot()).revision,
        }),
      ),
    ).toContain("not found");
    const client = createClient(WorkerEnrollmentService, createGrpcTransport({ baseUrl: gateway.grpcUrl }));
    const enrolled = await client.enroll({ enrollmentToken: invitation.token, host });
    expect(
      await failure(
        gateway.api.setEnvironmentTags({
          workerId: enrolled.workerId,
          tags: ["stolen"],
          expectedRevision: (await snapshot()).revision,
        }),
      ),
    ).toContain("not found");
    const before = await foreign.snapshot();
    expect(before.workers.find((w) => w.workerId === enrolled.workerId)?.manualTags).toEqual(["private"]);
    expect(
      await failure(
        foreign.tags(
          create(ui.SetEnvironmentTagsRequestSchema, {
            workerId: machine.workerId,
            tags: ["stolen"],
            expectedRevision: before.revision,
          }),
        ),
      ),
    ).toContain("not found");
    expect((await settled()).manualTags).toEqual(["team"]);
  });
});
