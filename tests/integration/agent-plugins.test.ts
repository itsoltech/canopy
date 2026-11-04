import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, AgentEnvironmentReportSchema, ui } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import { WorkerPlugins } from "../../apps/worker/src/agent-environment/plugins.ts";
import { Schema } from "effect";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { skillMachine } from "./support/agent-skills.ts";
import { sourceRepository } from "./support/skill-sources.ts";

const root = tempDir("canopy-plugin-integration-");
const repo = sourceRepository(root, "market");
let gateway: Awaited<ReturnType<typeof startTestGateway>>;
let machine: Awaited<ReturnType<typeof skillMachine>>;
let excluded: Awaited<ReturnType<typeof skillMachine>>;
let older: Awaited<ReturnType<typeof skillMachine>>;
let marketId = "";
let pluginId = "";
let firstCommit = "";
const snapshot = () => gateway.api.getAgentEnvironment({});
const current = async () => (await snapshot()).plugins.find((p) => p.assignment?.id === pluginId)!;

const bundle = (home: string, harness = "codex") =>
  join(home, "plugins/cache", `canopy-${pluginId}-${harness}`, "review", "local");

function assignment() {
  return create(ui.LibrarySkillSchema, {
    name: "Code review",
    platformHome: true,
    deviceHome: true,
    harnesses: ["claude", "codex"],
    selector: { tags: ["kind:desktop"], excludeTags: ["os:windows"] },
  });
}

beforeAll(async () => {
  repo.file(
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "test-market",
      owner: { name: "Fixture" },
      plugins: [
        { name: "review", source: "./plugins/review" },
        { name: "external", source: { source: "npm", package: "unreviewed" } },
        { name: "codex-only", source: { source: "local", path: "./plugins/codex-only" } },
      ],
    }),
  );
  repo.file(
    "plugins/codex-only/.codex-plugin/plugin.json",
    JSON.stringify({ name: "codex-only", description: "Native Codex local object source." }),
  );
  repo.file(
    "plugins/review/.claude-plugin/plugin.json",
    JSON.stringify({
      name: "review",
      description: "Reviewed fixture plugin.",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "false" }] }] },
    }),
  );
  repo.file("plugins/review/.mcp.json", JSON.stringify({ mcpServers: { fixture: { command: "false" } } }));
  repo.file("plugins/review/README.md", "First approved plugin version.");
  repo.skill("plugins/review/skills/review-code", "review-code");
  firstCommit = repo.commit();
  gateway = await startTestGateway({
    skillSources: { fixtureRepo: (url) => (url === "https://github.com/fixture/market.git" ? repo.bare : undefined) },
  });
  machine = await skillMachine(gateway, root, "plugin-linux");
  excluded = await skillMachine(gateway, root, "plugin-windows", "windows");
  older = await skillMachine(gateway, root, "plugin-older", "linux", false);
  await eventually(snapshot, (s) => s.workers.filter((w) => w.pluginsSupported).length === 2 && s.workers.length === 3);

  for (const home of [join(machine.dataDir, "claude-home"), machine.deviceHomes.claude]) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ env: { PRIVATE_FIXTURE: "never-report" }, enabledPlugins: { "private@personal": true } }),
    );
  }

  mkdirSync(join(machine.dataDir, "codex-home"), { recursive: true });
  writeFileSync(
    join(machine.dataDir, "codex-home/config.toml"),
    '# Private settings stay local\nmodel = "private-model"\n',
  );
}, 60_000);

afterAll(async () => {
  for (const worker of [machine, excluded, older]) {
    if (!worker) continue;
    worker.link.close();
    await worker.serving;
    await worker.host.close();
    await worker.runtime.dispose();
  }

  if (gateway) await gateway.close();
});

async function reported() {
  const s = await eventually(
    snapshot,
    (s) => s.workers.find((w) => w.workerId === machine.workerId)?.report?.revision === s.revision,
  );

  return s.workers.find((w) => w.workerId === machine.workerId)!.report!;
}

describe("owner-approved plugin marketplaces over WorkerLink", () => {
  test("catalog preview freezes a git commit; code cannot be assigned without explicit digest-bound audited consent", async () => {
    const before = await snapshot();
    const preview = await gateway.api.previewMarketplace({ command: "/plugin marketplace add fixture/market" });
    expect(preview.marketplace?.source?.commit).toBe(firstCommit);
    expect(preview.marketplace?.plugins[1]?.unavailableReason).toContain("External Git/npm");
    expect(preview.marketplace?.plugins[2]?.harnesses).toEqual(["codex"]);
    expect((await snapshot()).revision).toBe(before.revision);
    repo.file("plugins/review/README.md", "Moved before catalog confirmation.");
    repo.commit();
    const saved = await gateway.api.saveMarketplace({ previewId: preview.id, expectedRevision: before.revision });
    marketId = saved.marketplaces[0]!.id;
    expect(saved.marketplaces[0]?.source?.commit).toBe(firstCommit);
    expect(saved.plugins.length).toBe(0);

    const request = {
      marketplaceId: marketId,
      pluginName: "/plugin install review@test-market",
      assignment: assignment(),
      expectedRevision: saved.revision,
    };

    expect(await failure(gateway.api.saveLibraryPlugin(request))).toContain("explicitly confirm");
    expect(await failure(gateway.api.saveLibraryPlugin({ ...request, confirmedChecksum: "wrong" }))).toContain(
      "explicitly confirm",
    );

    const enabled = await gateway.api.saveLibraryPlugin({
      ...request,
      confirmedChecksum: saved.marketplaces[0]!.plugins[0]!.artifact!.checksum,
    });

    pluginId = enabled.plugins[0]!.assignment!.id;
    const report = await reported();
    expect(report.plugins.filter((p) => p.skillId === pluginId).length).toBe(6);
    expect(report.plugins.every((p) => p.status === "applied")).toBe(true);
    expect(readFileSync(join(bundle(join(machine.dataDir, "codex-home")), "README.md"), "utf8")).toBe(
      "First approved plugin version.",
    );
    expect(existsSync(bundle(join(excluded.dataDir, "codex-home")))).toBe(false);
    expect(existsSync(bundle(join(older.dataDir, "codex-home")))).toBe(false);
    expect(managedPlugins(machine.shadow, "claude").length).toBe(1);

    const audits = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          details: { checksum: string; commit: string };
        }>`SELECT details FROM audit_log WHERE target_id = ${pluginId}::uuid AND action = 'environment.plugin.confirm'`;
      }),
    );

    expect(audits[0]?.details.checksum).toBe(enabled.plugins[0]?.assignment?.artifact?.checksum);
    expect(audits[0]?.details.commit).toBe(firstCommit);
    expect(toJsonString(AgentEnvironmentReportSchema, report)).not.toContain("never-report");
  });

  test("actual isolated and device homes receive native declarations while unrelated local settings stay private", async () => {
    const codex = readFileSync(join(machine.dataDir, "codex-home/config.toml"), "utf8");
    expect(codex).toContain('model = "private-model"');
    expect(codex).toContain(`[plugins."review@canopy-${pluginId}-codex"]`);
    expect(codex).toContain('source_type = "local"');
    const claude = readFileSync(join(machine.dataDir, "claude-home/settings.json"), "utf8");
    expect(claude).toContain("private@personal");
    expect(claude).toContain("never-report");
    expect(claude).toContain(`review@canopy-${pluginId}`);
    const installed = readFileSync(join(machine.dataDir, "claude-home/plugins/installed_plugins.json"), "utf8");
    expect(installed).toContain('"version": 2');
    expect(installed).toContain(bundle(join(machine.dataDir, "claude-home"), "claude"));

    for (const harness of ["claude", "codex"]) expect(managedPlugins(machine.shadow, harness).length).toBe(1);
  });

  test("upstream update uses a frozen diff candidate; changing the catalog never silently updates enabled code", async () => {
    const preview = await gateway.api.previewMarketplace({ id: marketId });

    const saved = await gateway.api.saveMarketplace({
      previewId: preview.id,
      expectedRevision: (await snapshot()).revision,
    });

    expect((await current()).commit).toBe(firstCommit);
    expect((await current()).assignment?.version).toBe(1n);
    const candidate = saved.marketplaces[0]!.plugins[0]!.artifact!;
    const edit = clone(ui.LibrarySkillSchema, (await current()).assignment!);
    expect(
      await failure(
        gateway.api.saveLibraryPlugin({
          marketplaceId: marketId,
          pluginName: "review",
          assignment: edit,
          useLatest: true,
          confirmedChecksum: edit.artifact!.checksum,
          expectedRevision: saved.revision,
        }),
      ),
    ).toContain("explicitly confirm");
    await gateway.api.saveLibraryPlugin({
      marketplaceId: marketId,
      pluginName: "review",
      assignment: edit,
      useLatest: true,
      confirmedChecksum: candidate.checksum,
      expectedRevision: saved.revision,
    });
    expect((await current()).assignment?.version).toBe(2n);
    expect((await reported()).plugins.every((p) => p.status === "applied")).toBe(true);
    expect(readFileSync(join(bundle(machine.shadow), "README.md"), "utf8")).toBe("Moved before catalog confirmation.");
  });

  test.skipIf(!Bun.which("claude") || !Bun.which("codex"))(
    "native CLI readers recognize the declarative installation without a model session or install command",
    () => {
      const commands = [
        ["claude", "plugin", "list", "--json"],
        ["codex", "plugin", "list", "--json", "--marketplace", `canopy-${pluginId}-codex`],
      ];

      for (const command of commands) {
        const result = Bun.spawnSync(command, {
          cwd: machine.home,
          timeout: 20_000,
          env: {
            PATH: process.env["PATH"],
            HOME: machine.home,
            XDG_CONFIG_HOME: machine.home,
            TMPDIR: process.env["TMPDIR"],
            CLAUDE_CONFIG_DIR: join(machine.dataDir, "claude-home"),
            CODEX_HOME: join(machine.dataDir, "codex-home"),
          },
        });

        expect(result.exitCode).toBe(0);
        const output = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(result.stdout.toString()));
        expect(JSON.stringify(output)).toContain(`review@canopy-${pluginId}`);
      }
    },
    45_000,
  );

  test("tag reassignment removes and reinstalls the managed bundle while retaining private settings", async () => {
    const edit = clone(ui.LibrarySkillSchema, (await current()).assignment!);
    edit.selector = create(ui.EnvironmentSelectorSchema, { tags: ["team"] });
    await gateway.api.saveLibraryPlugin({
      marketplaceId: marketId,
      pluginName: "review",
      assignment: edit,
      confirmedChecksum: edit.artifact!.checksum,
      expectedRevision: (await snapshot()).revision,
    });
    await reported();
    expect(existsSync(join(bundle(machine.shadow), "README.md"))).toBe(false);
    const removedBundle = bundle(join(machine.dataDir, "claude-home"), "claude");
    expect(
      (existsSync(removedBundle) ? readdirSync(removedBundle, { recursive: true }) : []).filter(
        (path) => path !== ".in_use",
      ),
    ).toEqual([]);

    if (existsSync(removedBundle))
      expect(
        [...machine.host.environment.plugins.ledger.entries.values()].find((entry) => entry.path === removedBundle),
      ).toMatchObject({ owned: true, files: [] });
    await gateway.api.setEnvironmentTags({
      workerId: machine.workerId,
      tags: ["team"],
      expectedRevision: (await snapshot()).revision,
    });
    expect(
      (await reported()).plugins
        .filter((p) => p.status !== "applied")
        .map((p) => ({ path: p.path, status: p.status, owned: p.owned, detail: p.detail })),
    ).toEqual([]);
    expect(managedPlugins(machine.shadow, "codex").length).toBe(1);
  });

  test("restart restores bundle ownership and offline reconnect receives only the current assignment", async () => {
    const plugin = (await current()).assignment!;
    const restarted = new WorkerPlugins(machine.dataDir);

    const statuses = restarted.reconcile(
      create(AgentEnvironmentDesiredSchema, {
        plugins: [
          {
            id: plugin.id,
            version: plugin.version,
            artifact: plugin.artifact,
            harnesses: plugin.harnesses,
            deviceHome: plugin.deviceHome,
            platformHome: plugin.platformHome,
          },
        ],
      }),
      machine.host.environment.options.homes(),
    );

    expect(statuses.every((status) => status.status === "applied")).toBe(true);
    machine.link.close();
    await machine.serving;
    const edit = clone(ui.LibrarySkillSchema, plugin);
    edit.selector = create(ui.EnvironmentSelectorSchema, { tags: ["offline-only"] });
    await gateway.api.saveLibraryPlugin({
      marketplaceId: marketId,
      pluginName: "review",
      assignment: edit,
      confirmedChecksum: edit.artifact!.checksum,
      expectedRevision: (await snapshot()).revision,
    });
    edit.selector = create(ui.EnvironmentSelectorSchema, { tags: ["team"] });
    await gateway.api.saveLibraryPlugin({
      marketplaceId: marketId,
      pluginName: "review",
      assignment: edit,
      confirmedChecksum: edit.artifact!.checksum,
      expectedRevision: (await snapshot()).revision,
    });
    Object.assign(machine, await machine.connect());
    expect((await reported()).plugins.every((status) => status.status === "applied")).toBe(true);
  });

  test("activation drift and receipt drift block new sessions and accept fresh owned overwrite decisions", async () => {
    const home = join(machine.dataDir, "codex-home");
    const path = join(home, "config.toml");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace("enabled = true", "enabled = false"));
    expect(() => managedPlugins(home, "codex")).toThrow("activation changed");
    machine.host.environment.refresh(true);

    let report = await eventually(
      snapshot,
      (s) =>
        s.workers
          .find((w) => w.workerId === machine.workerId)
          ?.report?.plugins.some((p) => p.path === path && p.status === "drift") ?? false,
    );

    const file = report.workers
      .find((w) => w.workerId === machine.workerId)!
      .report!.plugins.find((p) => p.path === path)!;

    await gateway.api.resolvePluginDrift({
      workerId: machine.workerId,
      targetId: file.targetId,
      action: "overwrite",
      observedChecksum: file.observedChecksum,
      expectedRevision: report.revision,
    });
    await reported();
    expect(managedPlugins(home, "codex").length).toBe(1);
    const receipt = join(home, "canopy-codex-plugins.json");
    writeFileSync(receipt, readFileSync(receipt, "utf8").replace('"blocked": false', '"blocked": true'));
    machine.host.environment.refresh(true);
    report = await eventually(
      snapshot,
      (s) =>
        s.workers
          .find((w) => w.workerId === machine.workerId)
          ?.report?.plugins.some((p) => p.path === receipt && p.status === "drift") ?? false,
    );

    const drift = report.workers
      .find((w) => w.workerId === machine.workerId)!
      .report!.plugins.find((p) => p.path === receipt)!;

    expect(() => managedPlugins(home, "codex")).toThrow("attention");
    await gateway.api.resolvePluginDrift({
      workerId: machine.workerId,
      targetId: drift.targetId,
      action: "overwrite",
      observedChecksum: drift.observedChecksum,
      expectedRevision: report.revision,
    });
    await reported();
    expect(managedPlugins(home, "codex").length).toBe(1);
  });

  test("local code drift disables activation; keep/overwrite use one-shot CAS and do not transmit private extras", async () => {
    const home = join(machine.dataDir, "claude-home");
    const path = join(bundle(home, "claude"), "README.md");
    writeFileSync(path, "Locally edited plugin.");
    machine.host.environment.refresh(true);

    const state = await eventually(
      snapshot,
      (s) =>
        s.workers
          .find((w) => w.workerId === machine.workerId)
          ?.report?.plugins.some((p) => p.path === bundle(home, "claude") && p.status === "drift") ?? false,
    );

    const file = state.workers
      .find((w) => w.workerId === machine.workerId)!
      .report!.plugins.find((p) => p.path === bundle(home, "claude"))!;

    expect(() => managedPlugins(home, "claude")).toThrow("attention");
    await gateway.api.resolvePluginDrift({
      workerId: machine.workerId,
      targetId: file.targetId,
      action: "keep",
      observedChecksum: file.observedChecksum,
      expectedRevision: state.revision,
    });
    expect((await reported()).plugins.find((p) => p.targetId === file.targetId)?.status).toBe("kept");
    const kept = await snapshot();
    await gateway.api.resolvePluginDrift({
      workerId: machine.workerId,
      targetId: file.targetId,
      action: "overwrite",
      observedChecksum: file.observedChecksum,
      expectedRevision: kept.revision,
    });
    expect((await reported()).plugins.find((p) => p.targetId === file.targetId)?.status).toBe("applied");
    expect(managedPlugins(home, "claude").length).toBe(1);
    writeFileSync(path, "Locally edited plugin.");
    machine.host.environment.refresh(true);
    await eventually(
      snapshot,
      (s) =>
        s.workers
          .find((w) => w.workerId === machine.workerId)
          ?.report?.plugins.some((p) => p.targetId === file.targetId && p.status === "drift") ?? false,
    );
    // A second identical edit needs a new decision; the old overwrite was consumed.
    expect(readFileSync(path, "utf8")).toBe("Locally edited plugin.");
    writeFileSync(join(bundle(home, "claude"), "private-extra.txt"), "Never disclose this local extra.");
    machine.host.environment.refresh(true);
    const extraReport = await reported();
    expect(toJsonString(AgentEnvironmentReportSchema, extraReport)).not.toContain("Never disclose");
  });

  test("every library operation and drift decision is owner-scoped; shell commands and unsupported sources cannot mutate the library", async () => {
    const userId = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other-plugin@example.invalid", "Other")),
    );

    const other = new AgentEnvironment({ ...gateway.core.environment.options, userId });
    const s = await snapshot();
    const preview = await gateway.api.previewMarketplace({ id: marketId });
    expect(
      await failure(other.marketplaces.save(create(ui.SaveMarketplaceRequestSchema, { previewId: preview.id }))),
    ).toContain("not found");
    expect(
      await failure(other.marketplaces.preview(create(ui.PreviewMarketplaceRequestSchema, { id: marketId }))),
    ).toContain("not found");
    expect(
      await failure(
        other.plugins.save(
          create(ui.SaveLibraryPluginRequestSchema, {
            marketplaceId: marketId,
            pluginName: "review",
            assignment: (await current()).assignment,
          }),
        ),
      ),
    ).toContain("not found");
    expect(
      await failure(other.plugins.remove(create(ui.DeleteLibraryPluginRequestSchema, { id: pluginId }))),
    ).toContain("not found");
    expect(
      await failure(other.plugins.resolve(create(ui.ResolveSkillDriftRequestSchema, { workerId: machine.workerId }))),
    ).toContain("not found");
    expect((await other.snapshot()).marketplaces.length).toBe(0);

    for (const command of [
      "/plugin marketplace add fixture/market; id",
      "/plugin marketplace add $(id)",
      "/plugin marketplace add fixture/market --force",
      "file:///etc",
      "https://127.0.0.1/repo",
    ]) {
      expect(await failure(gateway.api.previewMarketplace({ command }))).not.toBe("");
    }

    expect((await snapshot()).revision).toBe(s.revision);
  });

  test("removal from upstream preserves the approved assignment and still permits edits and unassignment", async () => {
    repo.file(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "test-market",
        plugins: [{ name: "codex-only", source: { source: "local", path: "./plugins/codex-only" } }],
      }),
    );
    repo.commit();
    const preview = await gateway.api.previewMarketplace({ id: marketId });
    await gateway.api.saveMarketplace({ previewId: preview.id, expectedRevision: (await snapshot()).revision });
    const edit = clone(ui.LibrarySkillSchema, (await current()).assignment!);
    edit.name = "Still approved";
    await gateway.api.saveLibraryPlugin({
      marketplaceId: marketId,
      pluginName: "review",
      assignment: edit,
      confirmedChecksum: edit.artifact!.checksum,
      expectedRevision: (await snapshot()).revision,
    });
    expect((await current()).assignment?.artifact?.checksum).toBe(edit.artifact!.checksum);
    expect(
      await failure(
        gateway.api.saveLibraryPlugin({
          marketplaceId: marketId,
          pluginName: "review",
          assignment: edit,
          useLatest: true,
          confirmedChecksum: edit.artifact!.checksum,
          expectedRevision: (await snapshot()).revision,
        }),
      ),
    ).toContain("unavailable");
  });

  test("unassignment removes only owned code and settings; drift is retained for an explicit removal decision", async () => {
    const local = join(bundle(join(machine.dataDir, "claude-home"), "claude"), "README.md");
    await gateway.api.deleteLibraryPlugin({ id: pluginId, expectedRevision: (await snapshot()).revision });
    const report = await reported();
    expect(report.plugins.some((p) => p.status === "drift")).toBe(true);
    expect(readFileSync(local, "utf8")).toBe("Locally edited plugin.");
    expect(existsSync(join(bundle(join(machine.dataDir, "codex-home")), "README.md"))).toBe(false);
    expect(readFileSync(join(machine.dataDir, "codex-home/config.toml"), "utf8")).toBe(
      '# Private settings stay local\nmodel = "private-model"\n',
    );
    expect(readFileSync(join(machine.dataDir, "claude-home/settings.json"), "utf8")).not.toContain(
      `review@canopy-${pluginId}`,
    );
    const drift = report.plugins.find((p) => p.status === "drift")!;
    await gateway.api.resolvePluginDrift({
      workerId: machine.workerId,
      targetId: drift.targetId,
      observedChecksum: drift.observedChecksum,
      action: "overwrite",
      expectedRevision: (await snapshot()).revision,
    });
    await reported();
    expect(existsSync(local)).toBe(false);
    expect(
      readFileSync(join(bundle(join(machine.dataDir, "claude-home"), "claude"), "private-extra.txt"), "utf8"),
    ).toBe("Never disclose this local extra.");

    machine.host.environment.refresh(true);
    expect(
      (await reported()).plugins.find((file) => file.path === bundle(join(machine.dataDir, "claude-home"), "claude"))
        ?.status,
    ).toBe("removed");

    const removed = await gateway.api.deleteMarketplace({
      id: marketId,
      expectedRevision: (await snapshot()).revision,
    });

    expect(removed.marketplaces.length).toBe(0);
  });
});
