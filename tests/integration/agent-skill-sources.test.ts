import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { clone, create, toJson } from "@bufbuild/protobuf";
import { connectors, ui } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { skillChanges } from "@canopy/domain/skill-source";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { librarySkill, skillMachine } from "./support/agent-skills.ts";
import { skillRegistry, sourceRepository, sourceGitHttp } from "./support/skill-sources.ts";

const root = tempDir("canopy-skill-sources-");
const repo = sourceRepository(root, "collection");
const broken = sourceRepository(root, "broken");
const registry = skillRegistry();
const gitHttp = sourceGitHttp(root);
let gateway: Awaited<ReturnType<typeof startTestGateway>>;
let machine: Awaited<ReturnType<typeof skillMachine>>;
let firstCommit: string;
let id = "";
const snapshot = () => gateway.api.getAgentEnvironment({});
const current = async () => (await snapshot()).skills.find((s) => s.id === id)!;

const preview = (
  command = "npx skills@1.7.6 add fixture/collection --skill review tests --agent claude-code codex -g --copy -y",
  credentialAccountId = "",
) => gateway.api.previewSkillSource({ command, credentialAccountId });

beforeAll(async () => {
  repo.skill("skills/review", "review", "First reviewed version.");
  repo.skill("skills/testing", "tests");
  repo.file("LICENSE", "MIT fixture license");
  firstCommit = repo.commit();
  broken.skill("skills/bad", "bad");
  broken.commit();
  gateway = await startTestGateway({
    skillSources: {
      fixtureRepo: (url) => {
        if (url === "https://github.com/fixture/collection.git") return `${gitHttp.url}/collection.git`;

        if (url === "https://example.invalid/repo.git") return broken.bare;

        return undefined;
      },
      registryBaseUrl: registry.url,
    },
  });
  machine = await skillMachine(gateway, root, "source-computer");
  await eventually(snapshot, (s) => s.workers.some((w) => w.workerId === machine.workerId && w.skillsSupported));
}, 60_000);

afterAll(async () => {
  registry.stop();
  gitHttp.stop();

  if (machine) {
    machine.link.close();
    await machine.serving;
    await machine.host.close();
    await machine.runtime.dispose();
  }

  if (gateway) await gateway.close();
});

async function installed(text: string) {
  const state = await eventually(
    snapshot,
    (s) => s.workers.find((w) => w.workerId === machine.workerId)?.report?.revision === s.revision,
  );

  expect(
    state.workers
      .find((w) => w.workerId === machine.workerId)
      ?.report?.skills.some((f) => f.skillId === id && f.status === "applied"),
  ).toBe(true);
  expect(readFileSync(join(machine.dataDir, "codex-home/skills/review/SKILL.md"), "utf8")).toContain(text);
}

describe("gateway skill source resolution and maintenance", () => {
  test("pasted multi-skill command previews exact files, commit and executable flags without writes; owner confirms frozen artifacts", async () => {
    const before = await snapshot();
    const resolved = await preview();
    expect(resolved.skills.map((s) => s.artifact?.name)).toEqual(["review", "tests"]);
    expect(resolved.source?.commit).toBe(firstCommit);
    expect(resolved.harnesses).toEqual(["claude", "codex"]);
    expect(resolved.deviceHome).toBe(true);
    expect(resolved.skills[0]?.artifact?.files.find((f) => f.path === "scripts/check.sh")?.executable).toBe(true);
    expect((await snapshot()).revision).toBe(before.revision);
    expect(before.skills.length).toBe(0);
    repo.skill("skills/review", "review", "Moved before confirmation.");
    repo.commit();

    const added = await gateway.api.addSkillSource({
      previewId: resolved.id,
      paths: resolved.skills.map((s) => s.path),
      assignment: librarySkill(),
      expectedRevision: before.revision,
    });

    id = added.skills.find((s) => s.artifact?.name === "review")!.id;
    expect((await current()).source?.commit).toBe(firstCommit);
    expect((await current()).source?.autoUpdate).toBe(false);
    await installed("First reviewed version.");
    expect(
      await failure(
        gateway.api.addSkillSource({
          previewId: resolved.id,
          paths: ["skills/review"],
          assignment: librarySkill(),
          expectedRevision: added.revision,
        }),
      ),
    ).toContain("Preview expired");
  });

  test("detects upstream changes, exposes script-aware diff, applies reviewed candidate through reconcile and rolls back with provenance", async () => {
    const before = await current();
    repo.file("skills/review/scripts/check.sh", "#!/bin/sh\nprintf 'changed'\n");
    const nextCommit = repo.commit();
    const update = await gateway.api.checkSkillSource({ id });
    expect(update.source?.commit).toBe(nextCommit);
    expect((await current()).source?.availableCommit).toBe(nextCommit);
    const changes = skillChanges(before.artifact!, update.skills[0]!.artifact!);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: "SKILL.md", kind: "modified", script: false },
        { path: "scripts/check.sh", kind: "modified", script: true },
      ]),
    );
    expect((await current()).version).toBe(1n);

    const applied = await gateway.api.applySkillSource({
      id,
      previewId: update.id,
      expectedRevision: (await snapshot()).revision,
    });

    expect(applied.skills.find((s) => s.id === id)?.version).toBe(2n);
    await installed("Moved before confirmation.");
    const rollback = clone(ui.LibrarySkillSchema, await current());
    rollback.version = 1n;

    const result = await gateway.api.saveLibrarySkill({
      skill: rollback,
      expectedRevision: (await snapshot()).revision,
    });

    expect(result.skills.find((s) => s.id === id)?.source?.commit).toBe(firstCommit);
    expect(result.skills.find((s) => s.id === id)?.source?.pinned).toBe(true);
    await installed("First reviewed version.");
    expect(
      await failure(gateway.api.applySkillSource({ id, previewId: update.id, expectedRevision: result.revision })),
    ).toContain("Preview expired");
  });

  test("periodic checks survive service recreation; pin pauses them; auto-update accepts docs and holds executable changes for review", async () => {
    const pinned = await current();
    await gateway.core.environment.sources.tick();
    expect((await current()).version).toBe(1n);
    const edited = clone(ui.LibrarySkillSchema, pinned);
    edited.source!.pinned = false;
    edited.source!.autoUpdate = true;
    await gateway.api.saveLibrarySkill({ skill: edited, expectedRevision: (await snapshot()).revision });
    // The candidate contains a changed executable script: opt-in must not bypass its review.
    await gateway.core.environment.sources.tick();
    expect((await current()).version).toBe(1n);
    expect((await current()).source?.availableCommit).not.toBe("");
    const update = await gateway.api.checkSkillSource({ id });
    await gateway.api.applySkillSource({ id, previewId: update.id, expectedRevision: (await snapshot()).revision });
    repo.file("skills/review/README.md", "Updated usage instructions.");
    repo.commit();
    const restarted = new AgentEnvironment({ ...gateway.core.environment.options });
    await restarted.sources.tick(Date.now() + 3601_000);
    expect((await current()).version).toBe(4n);
    expect((await current()).artifact?.files.some((f) => f.path === "README.md")).toBe(true);
    await installed("Moved before confirmation.");
  });

  test("skills.sh references use the local catalog without executing its payload; subpaths, refs, root preference and skills.sh.json discovery work", async () => {
    const before = registry.requests("review");
    // Local port probes must not count as catalog lookups; duplicate lookups during this preview still fail.
    expect((await fetch(registry.url)).status).toBe(404);
    const catalog = await preview("https://skills.sh/fixture/collection/review");
    expect(registry.requests("review") - before).toBe(1);
    expect(catalog.skills.map((s) => s.artifact?.name)).toEqual(["review"]);
    registry.hostile(true);
    expect(await failure(preview("https://skills.sh/fixture/collection/review"))).toContain("catalog");
    registry.hostile(false);
    expect((await preview("bunx skills add fixture/collection/skills/review --skill review")).skills.length).toBe(1);
    expect(
      (await preview(`https://github.com/fixture/collection/tree/${firstCommit}/skills/review`)).source?.commit,
    ).toBe(firstCommit);
    expect((await preview(`fixture/collection#${firstCommit}@review`)).skills[0]?.artifact?.name).toBe("review");
    repo.git("tag", "fixture-v1", firstCommit);
    repo.git("push", "origin", "refs/tags/fixture-v1");
    expect((await preview("fixture/collection#fixture-v1@review")).source?.commit).toBe(firstCommit);
    repo.skill("extra/team", "team");
    repo.file("skills.sh.json", '{"paths":["./extra"]}');
    repo.commit();
    expect((await preview("fixture/collection")).skills.map((s) => s.artifact?.name)).toContain("team");
    repo.skill("root", "root");
    repo.file("SKILL.md", "---\nname: collection-root\ndescription: Root skill.\n---\nRoot skill content.\n");
    repo.commit();
    expect((await preview("fixture/collection")).skills.map((s) => s.artifact?.name)).toEqual(["collection-root"]);
    expect((await preview("npx skills add fixture/collection --full-depth")).skills.length).toBeGreaterThan(1);
  });

  test("owner scoping covers previews, credentials, update operations and immutable versions; credentials never enter snapshots, frozen artifacts, worker reports or audit", async () => {
    const secret = `fixture-${Bun.randomUUIDv7()}`;
    gitHttp.expect(`Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`);

    const account = await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.connectors.save(
          gateway.userId,
          create(connectors.SaveConnectorAccountRequestSchema, {
            name: "Source access",
            connectorType: "github",
            authKind: "headers",
            token: secret,
          }),
        ),
      ),
    );

    const resolved = await preview("fixture/collection/skills/review", account.id);
    expect(gitHttp.authenticated()).toBe(true);

    const user = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other-source@example.invalid", "Other")),
    );

    const other = new AgentEnvironment({ ...gateway.core.environment.options, userId: user });
    expect(
      await failure(
        other.sources.preview(
          create(ui.PreviewSkillSourceRequestSchema, {
            command: "fixture/collection",
            credentialAccountId: account.id,
          }),
        ),
      ),
    ).toContain("connected account hasn't arrived on this computer");
    expect(await failure(other.sources.db.load(resolved.id))).toContain("not found");
    expect(await failure(other.sources.check(create(ui.CheckSkillSourceRequestSchema, { id })))).toContain("not found");
    expect(
      await failure(other.sources.apply(create(ui.ApplySkillSourceRequestSchema, { id, previewId: resolved.id }))),
    ).toContain("not found");
    expect(await failure(preview("https://example.invalid/repo.git", account.id))).toContain("connector");
    expect(JSON.stringify(toJson(ui.SkillSourcePreviewSchema, resolved))).not.toContain(secret);
    expect(JSON.stringify(toJson(ui.AgentEnvironmentSnapshotSchema, await snapshot()))).not.toContain(secret);

    const stored = await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          text: string;
        }>`SELECT preview::text AS text FROM agent_skill_source_previews UNION ALL SELECT artifact::text FROM agent_skill_versions UNION ALL SELECT details::text FROM audit_log`;
      }),
    );

    expect(stored.every((r) => !r.text.includes(secret))).toBe(true);

    const sameOrigin = await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.connectors.save(
          gateway.userId,
          create(connectors.SaveConnectorAccountRequestSchema, {
            name: "Same-origin access",
            connectorType: "custom",
            url: "https://github.com/",
            authKind: "headers",
            token: secret,
          }),
        ),
      ),
    );

    expect((await preview("fixture/collection/skills/review", sameOrigin.id)).source?.commit).not.toBe("");
    await gateway.runtime.runPromise(GatewayStore.use((s) => s.connectors.disconnect(gateway.userId, account.id)));
    expect(
      await failure(
        gateway.api.addSkillSource({
          previewId: resolved.id,
          paths: ["skills/review"],
          assignment: librarySkill(),
          expectedRevision: (await snapshot()).revision,
        }),
      ),
    ).toContain("connector");
  });

  test("closed parser and fetch boundary reject hostile commands, local protocols, metadata hosts and malformed trees without environment mutations", async () => {
    const before = await snapshot();

    for (const command of [
      "npx skills add fixture/collection; touch /tmp/pwn",
      "bunx skills add $(id)",
      "npx skills add fixture/collection | cat",
      "npx other add fixture/collection",
      "npx skills add fixture/collection --dangerous",
      "file:///etc",
      "git@github.com:fixture/repo",
      "https://user:secret@github.com/fixture/repo",
      "https://127.0.0.1/repo.git",
      "https://169.254.169.254/repo.git",
      "fixture/collection/../escape",
      "npx skills add 'fixture/collection",
    ]) {
      expect(await failure(preview(command))).not.toBe("");
    }

    broken.file("skills/bad/oversized.bin", new Uint8Array(1024 * 1024 + 1));
    broken.commit();
    expect(await failure(preview("https://example.invalid/repo.git"))).toContain("limit");
    broken.git("rm", "skills/bad/oversized.bin");
    symlinkSync("../../outside", join(broken.work, "skills/bad/escape"));
    broken.commit();
    expect(await failure(preview("https://example.invalid/repo.git"))).toContain("symlinks");
    const requests: string[] = [];

    const dumb = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requests.push(path);

        return new Response(path.endsWith("/HEAD") ? "ref: refs/heads/main\n" : `${firstCommit}\trefs/heads/main\n`, {
          headers: { "content-type": "text/plain" },
        });
      },
    });

    const isolated = new AgentEnvironment({
      ...gateway.core.environment.options,
      sources: { fixtureRepo: () => `${dumb.url.origin}/repo.git` },
    });

    try {
      expect(
        await failure(
          isolated.sources.preview(create(ui.PreviewSkillSourceRequestSchema, { command: "fixture/collection" })),
        ),
      ).not.toBe("");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((path) => path.endsWith("/info/refs") || path.endsWith("/HEAD"))).toBe(true);
    } finally {
      await isolated.sources.stop();
      dumb.stop(true);
    }

    expect((await snapshot()).revision).toBe(before.revision);
  });

  test("shutdown cancels and drains a stalled source fetch without saving a preview or leaving its temporary repository", async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();

    const stalled = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        started.resolve();

        return response.promise;
      },
    });

    const environment = new AgentEnvironment({
      ...gateway.core.environment.options,
      sources: {
        fixtureRepo: () => `${stalled.url.origin}/collection.git`,
      },
    });

    const before = await snapshot();

    const resolving = failure(
      environment.sources.preview(create(ui.PreviewSkillSourceRequestSchema, { command: "fixture/collection" })),
    );

    try {
      await started.promise;
      expect(
        await failure(
          environment.sources.preview(create(ui.PreviewSkillSourceRequestSchema, { command: "fixture/collection" })),
        ),
      ).toContain("already being resolved");
      await environment.sources.stop();
      expect(await resolving).not.toBe("");
      expect((await snapshot()).revision).toBe(before.revision);
    } finally {
      response.resolve(new Response("Stopped", { status: 503 }));
      stalled.stop(true);
      await environment.sources.stop();
    }
  });
});
