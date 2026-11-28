import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, toJsonString } from "@bufbuild/protobuf";
import { connectors, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eligibleSourceAccounts } from "@canopy/domain/source-access";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { librarySkill } from "./support/agent-skills.ts";
import { connectGitHub, githubPrFixture } from "./support/github-pr.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure, type TestGateway } from "./support/gateway.ts";

const rejectionCode = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (cause) => ConnectError.from(cause).code,
  );

const name = "itsoltech/canopy";
const treeSha = "b".repeat(40);

function file(path: string, content: string) {
  const data = Buffer.from(content);
  const sha = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

  return {
    entry: { path, mode: "100644", type: "blob", size: data.length, sha, url: "https://example.invalid/blob" },
    blob: { content: data.toString("base64"), size: data.length, encoding: "base64", sha },
  };
}

describe.skipIf(!dockerAvailable)("private sources through the selected GitHub account", () => {
  const fixture = githubPrFixture();
  let gw: TestGateway;
  let home: ConfigComputer;
  let installed = true;
  let pull = true;
  let contents = true;
  let redirect = false;
  let commit = "a".repeat(40);

  let files = [
    file("skills/review/SKILL.md", "---\nname: review\ndescription: Review changes.\n---\nOriginal.\n"),
    file(".claude-plugin/marketplace.json", JSON.stringify({ name: "shared-market", plugins: [] })),
  ];

  const reads: string[] = [];
  let gitLookups = 0;

  const git = {
    fixtureRepo: () => {
      gitLookups++;
      throw new Error("Unexpected Git transport");
    },
  };

  const revision = async () => (await gw.api.getAgentEnvironment({})).revision;

  const skill = () =>
    gw.api.previewSkillSource({ command: `${name}/skills/review#release`, credentialAccountId: "github:101" });

  beforeAll(async () => {
    fixture.intercept((request) => {
      const { pathname, searchParams } = new URL(request.url);

      if (/^\/user\/installations\/\d+\/repositories$/.test(pathname) && !installed)
        return Response.json({ total_count: 0, repositories: [] });

      if (pathname === `/repos/${name}` && !pull)
        return Response.json({ id: 777, full_name: name, private: true, permissions: { pull: false } });

      if (pathname === "/redirected-source") reads.push(pathname);

      if (!pathname.startsWith("/repositories/")) return;
      reads.push(pathname);

      if (pathname === "/repositories/777/commits") {
        if (redirect) return Response.redirect(new URL("/redirected-source", request.url), 302);

        if (searchParams.has("sha") && searchParams.get("sha") !== "release")
          return new Response(null, { status: 404 });

        return Response.json([{ sha: commit, commit: { tree: { sha: treeSha } } }]);
      }

      if (pathname.startsWith("/repositories/777/git/commits/"))
        return contents ? Response.json({ sha: pathname.split("/").at(-1) }) : new Response(null, { status: 403 });

      if (pathname === `/repositories/777/git/trees/${treeSha}` && searchParams.get("recursive") === "1")
        return Response.json({ sha: treeSha, tree: files.map((f) => f.entry), truncated: false });
      const blob = files.find((f) => pathname === `/repositories/777/git/blobs/${f.entry.sha}`)?.blob;

      if (blob) return Response.json(blob);

      return new Response(null, { status: 404 });
    });
    home = await configComputer("Source home", undefined, git, fixture.options);
    gw = home.gateway;
    await connectGitHub(gw, fixture);
  }, 60_000);

  afterAll(async () => {
    await home?.close();
    fixture.close();
  });

  test("imports a skill without a connector and updates a frozen version after restart", async () => {
    const accounts = await gw.api.listGitHubAccounts({});
    const choices = eligibleSourceAccounts(name, "skill", [], accounts.accounts);
    expect(choices.map((c) => c.id)).toEqual(["github:101"]);
    expect(eligibleSourceAccounts("https://example.invalid/repo.git", "skill", [], accounts.accounts)).toEqual([]);
    expect((await gw.api.listConnectors({})).accounts).toHaveLength(0);
    const preview = await skill();
    expect(preview.source?.credentialAccountId).toBe("github:101:777");
    expect(preview.source?.commit).toBe("a".repeat(40));

    const snapshot = await gw.api.addSkillSource({
      previewId: preview.id,
      paths: ["skills/review"],
      assignment: librarySkill(),
      expectedRevision: await revision(),
    });

    const id = snapshot.skills[0]!.id;

    await home.restart();
    gw = home.gateway;
    files = [
      file("skills/review/SKILL.md", "---\nname: review\ndescription: Review changes.\n---\nUpdated.\n"),
      files[1]!,
    ];
    commit = "c".repeat(40);
    const candidate = await gw.api.checkSkillSource({ id });
    expect(candidate.source?.commit).toBe(commit);
    const updated = await gw.api.applySkillSource({ id, previewId: candidate.id, expectedRevision: await revision() });
    expect(updated.skills[0]?.version).toBe(2n);
    expect(Buffer.from(updated.skills[0]!.artifact!.files[0]!.content).toString()).toContain("Updated.");
    expect(gitLookups).toBe(0);

    for (const secret of fixture.secrets)
      expect(toJsonString(ui.AgentEnvironmentSnapshotSchema, updated)).not.toContain(secret);
  }, 60_000);

  test("a frozen marketplace cannot be saved after its repository leaves the installation", async () => {
    const preview = await gw.api.previewMarketplace({ command: name, credentialAccountId: "github:101" });
    expect(preview.marketplace?.name).toBe("shared-market");
    installed = false;

    try {
      expect(
        await rejectionCode(gw.api.saveMarketplace({ previewId: preview.id, expectedRevision: await revision() })),
      ).toBe(Code.PermissionDenied);
    } finally {
      installed = true;
    }
  });

  test("a selected PAT can refresh its marketplace only while it can read the pinned repository", async () => {
    const legacy = await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.connectors.save(
          gw.userId,
          create(connectors.SaveConnectorAccountRequestSchema, {
            connectorType: "github",
            name: "Imported PAT",
            authKind: "headers",
            token: fixture.pat(202),
          }),
        ),
      ),
    );

    await gw.api.useGitHubPat({ connectorAccountId: legacy.id });
    const githubAccounts = (await gw.api.listGitHubAccounts({})).accounts;
    const connectorAccounts = (await gw.api.listConnectors({})).accounts;
    expect(
      eligibleSourceAccounts(name, "marketplace", connectorAccounts, githubAccounts)
        .map((item) => item.id)
        .sort(),
    ).toEqual(["github:101", "github:202"]);
    const preview = await gw.api.previewMarketplace({ command: name, credentialAccountId: "github:202" });
    contents = false;

    try {
      expect(
        await rejectionCode(gw.api.saveMarketplace({ previewId: preview.id, expectedRevision: await revision() })),
      ).toBe(Code.PermissionDenied);
    } finally {
      contents = true;
    }

    const saved = await gw.api.saveMarketplace({ previewId: preview.id, expectedRevision: await revision() });
    const market = saved.marketplaces[0]!;
    expect(market.source?.credentialAccountId).toBe("github:202:777");
    expect((await gw.api.previewMarketplace({ id: market.id })).baseCommit).toBe(commit);
    const calls = reads.length;
    pull = false;

    try {
      expect(await rejectionCode(gw.api.previewMarketplace({ id: market.id }))).toBe(Code.PermissionDenied);
      expect(reads).toHaveLength(calls);
    } finally {
      pull = true;
    }
  });

  test("the shared skill uses the same GitHub identity independently connected on its receiving home", async () => {
    const peer = await configComputer("Receiving home", undefined, git, fixture.options);

    try {
      files.push(file("skills/shared/SKILL.md", "---\nname: shared\ndescription: Share project notes.\n---\nNotes.\n"));

      const preview = await gw.api.previewSkillSource({
        command: `${name}/skills/shared`,
        credentialAccountId: "github:101",
      });

      const saved = await gw.api.addSkillSource({
        previewId: preview.id,
        paths: ["skills/shared"],
        assignment: { ...librarySkill(), name: "Shared notes" },
        expectedRevision: await revision(),
      });

      const id = saved.skills.find((item) => item.name === "Shared notes")!.id;
      await pairConfig(home, peer);

      const state = await eventually(
        () => peer.gateway.api.getAgentEnvironment({}),
        (s) => s.skills.some((item) => item.id === id),
      );

      const shared = state.skills.find((item) => item.id === id)!;
      expect(shared.source?.credentialAccountId).toBe("github:101:777");
      await connectGitHub(peer.gateway, fixture, 303);
      const before = reads.length;
      expect(await failure(peer.gateway.api.checkSkillSource({ id: shared.id }))).toContain("on this computer");
      expect(reads).toHaveLength(before);
      await connectGitHub(peer.gateway, fixture);
      const verified = await peer.gateway.api.checkSkillSource({ id: shared.id });
      expect(verified.source?.commit).toBe(commit);
      expect(verified.source?.credentialAccountId).toBe("github:101:777");
    } finally {
      await peer.close();
    }
  }, 30_000);

  test("rejects another origin, a different pinned repository ID, and an HTTP redirect before reading any blob", async () => {
    const count = reads.length;
    expect(
      await rejectionCode(
        gw.api.previewSkillSource({ command: "https://example.invalid/repo.git", credentialAccountId: "github:101" }),
      ),
    ).toBe(Code.InvalidArgument);
    expect(
      await rejectionCode(gw.api.previewSkillSource({ command: name, credentialAccountId: "github:101:888" })),
    ).toBe(Code.FailedPrecondition);
    expect(reads).toHaveLength(count);
    redirect = true;

    try {
      expect(await rejectionCode(skill())).toBe(Code.InvalidArgument);
      expect(reads.slice(count)).toEqual(["/repositories/777/commits"]);
    } finally {
      redirect = false;
    }
  });
});
