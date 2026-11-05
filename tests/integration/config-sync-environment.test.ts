import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { computerLink, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import type { ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { librarySkill, skillFiles, skillMachine } from "./support/agent-skills.ts";
import { sourceRepository } from "./support/skill-sources.ts";
import { eventually, failure } from "./support/gateway.ts";

const root = tempDir("canopy-config-environment-");
const repo = sourceRepository(root, "market");

const sources = {
  fixtureRepo: (url: string) => (url === "https://github.com/fixture/market.git" ? repo.bare : undefined),
};

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const library = (c: ConfigComputer) => c.gateway.api.getAgentEnvironment({});
const skillNamed = async (c: ConfigComputer, name: string) => (await library(c)).skills.find((s) => s.name === name);

const hashes = async (c: ConfigComputer, table: string) =>
  (await c.store.query<{ content_hash: string }>(`SELECT content_hash FROM ${table} ORDER BY content_hash`)).map(
    (r) => r.content_hash,
  );

async function upload(c: ConfigComputer, skill: ui.LibrarySkill, content: string) {
  return c.gateway.api.saveLibrarySkill({
    skill,
    files: skillFiles("code-review", content),
    expectedRevision: (await library(c)).revision,
  });
}

describe.skipIf(!dockerAvailable)("agent environment library across separate linked databases", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let worker: Awaited<ReturnType<typeof skillMachine>>;
  beforeAll(async () => {
    repo.file(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "team-market",
        owner: { name: "Fixture" },
        plugins: [{ name: "review", source: "./plugins/review" }],
      }),
    );
    repo.file("plugins/review/.claude-plugin/plugin.json", JSON.stringify({ name: "review", description: "Review." }));
    repo.skill("plugins/review/skills/review-code", "review-code");
    repo.commit();
    a = await configComputer("Laptop A", undefined, sources);
    b = await configComputer("Laptop B", undefined, sources);
    worker = await skillMachine(b.gateway, root, "worker-b");
    await eventually(
      () => library(b),
      (s) => s.workers.some((w) => w.workerId === worker.workerId && w.skillsSupported),
    );
    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
  }, 120_000);
  afterAll(async () => {
    worker?.link.close();
    await worker?.serving;
    await worker?.host.close();
    await worker?.runtime.dispose();
    await a?.close();
    await b?.close();
  }, 30_000);

  test("a document, a skill and a plugin from A arrive on B with the same hash-verified content", async () => {
    let snapshot = await a.gateway.api.saveInstructionDocument({
      document: {
        name: "Team rules",
        harness: "codex",
        platformHome: true,
        selector: { everyone: true },
        fragments: [{ id: "intro", name: "Intro", content: "Write tests for every change." }],
      },
      expectedRevision: (await library(a)).revision,
    });

    snapshot = await upload(a, librarySkill(), "Review the patch carefully.");
    const preview = await a.gateway.api.previewMarketplace({ command: "/plugin marketplace add fixture/market" });
    snapshot = await a.gateway.api.saveMarketplace({ previewId: preview.id, expectedRevision: snapshot.revision });
    const market = snapshot.marketplaces[0]!;

    snapshot = await a.gateway.api.saveLibraryPlugin({
      marketplaceId: market.id,
      pluginName: "/plugin install review@team-market",
      assignment: create(ui.LibrarySkillSchema, {
        name: "review",
        harnesses: ["claude"],
        platformHome: true,
        selector: { everyone: true },
      }),
      confirmedChecksum: market.plugins[0]!.artifact!.checksum,
      expectedRevision: snapshot.revision,
    });

    await wait(async () => (await library(b)).plugins.length === 1);
    const there = await library(b);
    expect(there.documents.map((d) => [d.id, d.name, d.fragments[0]?.content])).toEqual([
      [snapshot.documents[0]!.id, "Team rules", "Write tests for every change."],
    ]);
    expect(there.skills[0]?.artifact?.checksum).toBe(snapshot.skills[0]!.artifact!.checksum);
    expect(there.marketplaces[0]?.source?.commit).toBe(market.source!.commit);
    expect(there.plugins[0]?.assignment?.artifact?.checksum).toBe(market.plugins[0]!.artifact!.checksum);

    for (const table of ["agent_skill_versions", "agent_plugin_versions", "agent_marketplace_catalogs"])
      expect(await hashes(b, table)).toEqual(await hashes(a, table));

    // The worker of B installs the skill made on A, byte for byte.
    const installed = join(worker.deviceHomes.claude, "skills/code-review/SKILL.md");
    await wait(() => existsSync(installed));
    expect(readFileSync(installed, "utf8")).toContain("Review the patch carefully.");

    const edited = snapshot.documents[0]!;
    edited.fragments[0]!.content = "Write tests and docs for every change.";
    await a.gateway.api.saveInstructionDocument({ document: edited, expectedRevision: (await library(a)).revision });
    await wait(
      async () => (await library(b)).documents[0]?.fragments[0]?.content === "Write tests and docs for every change.",
    );
  }, 60_000);

  test("machine overrides stay on their computer; assignments keep workers of other computers", async () => {
    let skill = (await skillNamed(b, "Code review"))!;
    skill.overrides = [create(ui.SkillMachineOverrideSchema, { workerId: worker.workerId, disabled: true })];
    await b.gateway.api.saveLibrarySkill({ skill, expectedRevision: (await library(b)).revision });
    await Bun.sleep(500);
    expect(JSON.stringify(await a.store.query("SELECT fields FROM config_items"))).not.toContain(worker.workerId);
    expect((await skillNamed(a, "Code review"))?.overrides).toEqual([]);

    skill = (await skillNamed(a, "Code review"))!;
    skill.selector = create(ui.EnvironmentSelectorSchema, { workerIds: [a.gateway.workerId] });
    await a.gateway.api.saveLibrarySkill({ skill, expectedRevision: (await library(a)).revision });
    await wait(async () => (await skillNamed(b, "Code review"))?.selector?.workerIds[0] === a.gateway.workerId);
    expect((await skillNamed(b, "Code review"))?.overrides.map((o) => o.workerId)).toEqual([worker.workerId]);

    // B saves the item again: A's worker stays in the shared assignment.
    skill = (await skillNamed(b, "Code review"))!;
    skill.name = "Code review";
    skill.deviceHome = false;
    await b.gateway.api.saveLibrarySkill({ skill, expectedRevision: (await library(b)).revision });
    await wait(async () => (await skillNamed(a, "Code review"))?.deviceHome === false);
    expect((await skillNamed(a, "Code review"))?.selector?.workerIds).toEqual([a.gateway.workerId]);
    skill = (await skillNamed(a, "Code review"))!;
    skill.selector = create(ui.EnvironmentSelectorSchema, { everyone: true });
    skill.deviceHome = true;
    await a.gateway.api.saveLibrarySkill({ skill, expectedRevision: (await library(a)).revision });
    await wait(async () => !!(await skillNamed(b, "Code review"))?.selector?.everyone);
  }, 40_000);

  test("concurrent uploads become two versions on both; a notice restores the other one", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    await upload(a, (await skillNamed(a, "Code review"))!, "Edited on A.");
    await upload(b, (await skillNamed(b, "Code review"))!, "Edited on B.");
    await a.sharing(b.node, true);
    await wait(async () => (await skillNamed(a, "Code review"))?.versions.length === 3);
    await wait(async () => (await skillNamed(b, "Code review"))?.versions.length === 3);
    await wait(
      async () =>
        (await skillNamed(a, "Code review"))?.artifact?.checksum ===
        (await skillNamed(b, "Code review"))?.artifact?.checksum,
    );
    expect(await hashes(b, "agent_skill_versions")).toEqual(await hashes(a, "agent_skill_versions"));
    const winner = (await skillNamed(a, "Code review"))!.artifact!.checksum;

    const notices = [...(await a.links.snapshot()).configNotices, ...(await b.links.snapshot()).configNotices];
    const notice = notices.find((n) => n.kind === "skill" && n.field === "selected");
    expect(notice).toMatchObject({ itemName: "Code review", reason: "concurrent" });
    const side = (await a.links.snapshot()).configNotices.some((n) => n.id === notice!.id) ? a : b;
    await side.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });

    for (const c of [a, b])
      await wait(async () => {
        const skill = await skillNamed(c, "Code review");

        return !!skill?.artifact && skill.artifact.checksum !== winner;
      });
  }, 40_000);

  test("deletion leaves a tombstone with one Restore notice on the other computer", async () => {
    const skill = (await skillNamed(a, "Code review"))!;
    await a.gateway.api.deleteLibrarySkill({ id: skill.id, expectedRevision: (await library(a)).revision });
    await wait(async () => !(await skillNamed(b, "Code review")));

    const tombstone = (
      await b.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='skill' AND global_id=$1", [skill.id])
    )[0]!;

    expect(tombstone.deleted.value).toBe(true);
    expect(Object.keys(tombstone.fields)).toEqual([]);
    const notice = (await b.links.snapshot()).configNotices.find((n) => n.kind === "skill" && n.field === "deleted");
    expect(notice).toMatchObject({ reason: "deleted", itemName: "Code review" });
    expect((await a.links.snapshot()).configNotices.some((n) => n.kind === "skill" && n.field === "deleted")).toBe(
      false,
    );
    await b.gateway.api.manageConfigNotice({ id: notice!.id, action: "restore" });
    await wait(async () => (await skillNamed(a, "Code review"))?.artifact?.checksum === skill.artifact?.checksum);
    expect((await skillNamed(b, "Code review"))?.versions).toHaveLength(3);
  }, 40_000);

  test("nothing crosses a link with sharing off, content included; reconnecting catches up", async () => {
    await b.sharing(a.node, false);
    await wait(() => !configAllowed(a.links, b.node));
    await a.gateway.api.saveInstructionDocument({
      document: { name: "Private while apart", harness: "claude", platformHome: true, selector: { everyone: true } },
      expectedRevision: (await library(a)).revision,
    });
    const [hash] = await hashes(a, "agent_skill_versions");
    expect(await failure(b.links.config!.fetchBlob!(a.node, hash!))).toBeTruthy();
    await Bun.sleep(1000);
    expect((await library(b)).documents.some((d) => d.name === "Private while apart")).toBe(false);
    await b.sharing(a.node, true);
    await wait(async () => (await library(b)).documents.some((d) => d.name === "Private while apart"));
  }, 40_000);

  test("content must match its hash; another owner's library is never recorded, served or changed", async () => {
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await a.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    const artifact = JSON.stringify({ name: "secret-skill", description: "x", checksum: "c", files: [] });
    await a.store.query(
      `INSERT INTO agent_skills(id,owner_user_id,definition) VALUES($1::uuid,$2::uuid,'{"name":"Foreign","version":"1"}')`,
      [foreign, owner],
    );
    await a.store.query(
      "INSERT INTO agent_skill_versions(skill_id,owner_user_id,version,artifact) VALUES($1::uuid,$2::uuid,1,$3::jsonb)",
      [foreign, owner, artifact],
    );

    const [foreignHash] = (
      await a.store.query<{ content_hash: string }>(
        "SELECT content_hash FROM agent_skill_versions WHERE skill_id=$1::uuid",
        [foreign],
      )
    ).map((r) => r.content_hash);

    expect(await failure(b.links.config!.fetchBlob!(a.node, foreignHash!))).toContain("not found");

    // A record that names another owner's row is kept but changes nothing.
    const source = (await b.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='skill'"))[0]!;
    const incoming = structuredClone(source);
    incoming.global_id = foreign;
    incoming.fields["name"]!.value = "Foreign probe";
    await a.links.config!.receive(
      b.node,
      create(computerLink.ConfigUpdateSchema, { items: [wireItem(incoming)] }),
      () => true,
    );
    expect(
      (
        await a.store.query<{ definition: { name: string } }>("SELECT definition FROM agent_skills WHERE id=$1::uuid", [
          foreign,
        ])
      )[0]?.definition.name,
    ).toBe("Foreign");

    // Tampered content for a new version never reaches the library.
    const fetch = b.links.config!.fetchBlob!;
    b.links.config!.fetchBlob = async (node, hash) => {
      const bytes = await fetch(node, hash);

      return Buffer.concat([bytes, Buffer.from(" ")]);
    };

    try {
      const skill = (await skillNamed(a, "Code review"))!;
      await upload(a, skill, "Tampered on the way.");
      await wait(
        async () =>
          (
            await b.store.query<ConfigRow>(
              "SELECT * FROM config_items WHERE kind='skill' AND unsupported='Waiting for files from a linked computer'",
            )
          ).length > 0,
      );
      expect((await skillNamed(b, "Code review"))?.versions).toHaveLength(3);
      // A local write records only this owner's library.
      expect(await a.store.query("SELECT 1 FROM config_items WHERE fields->'name'->>'value'='Foreign'")).toHaveLength(
        0,
      );
      expect(
        (
          await a.store.query<{ unsupported: string }>("SELECT unsupported FROM config_items WHERE local_id=$1", [
            foreign,
          ])
        )[0]?.unsupported,
      ).toBe("Not supported on this computer");
    } finally {
      b.links.config!.fetchBlob = fetch;
    }
  }, 60_000);
  test("a source's connected account from another computer degrades with a clear reason", async () => {
    const market = (await library(b)).marketplaces[0]!;
    await b.store.query(
      `UPDATE agent_marketplaces SET marketplace=jsonb_set(marketplace,'{source,credentialAccountId}',to_jsonb($2::text))
      WHERE id=$1::uuid`,
      [market.id, crypto.randomUUID()],
    );
    expect(await failure(b.gateway.api.previewMarketplace({ id: market.id }))).toContain(
      "connected account is on another computer",
    );
  }, 30_000);
});
