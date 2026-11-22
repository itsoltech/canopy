import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, SandboxProfileSchema, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { nodeRef } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { SANDBOX_PROFILES_CAPABILITY } from "@canopy/domain/sandbox-profiles";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("sandbox selections on composer drafts", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const profile = { id: Bun.randomUUIDv7(), name: "Offline", allowedDomains: [] };

  const saveCatalog = async (selected: typeof profile) => {
    const { user } = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: user!.version, sandboxProfiles: { profiles: [selected] } });
  };

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: { hello: { capabilities: [SANDBOX_PROFILES_CAPABILITY] }, sandboxOffline: true },
    });

    const ready = await eventually(
      () => gw.api.getOverview({}),
      (overview) => overview.workers.some((worker) => worker.profiles.some((entry) => entry.sandboxSupport?.offline)),
    );

    expect(ready.workers.some((worker) => worker.profiles.some((entry) => entry.sandboxSupport?.offline))).toBe(true);
    projectId = (await gw.api.createProject({ name: "Sandbox drafts" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/drafts" }))
      .workspace!.id;
    await saveCatalog(profile);
  }, 60_000);

  afterAll(async () => gw?.close());

  const draft = () =>
    create(ui.ComposerDraftSchema, {
      id: Bun.randomUUIDv7(),
      deviceId: "desktop",
      deviceName: "Desktop",
      target: { projectId, workspaceId },
      content: {
        clientRequestId: Bun.randomUUIDv7(),
        text: "Continue within the selected sandbox.",
        permissionMode: PermissionMode.FULL_AUTO,
        provider: Provider.CODEX,
        sandboxProfile: profile,
      },
    });

  const save = (value: ui.ComposerDraft, clearSandboxProfile = false) =>
    gw.api.saveComposerDraft({
      draft: value,
      expectedRevision: value.revision,
      mutationId: Bun.randomUUIDv7(),
      clearSandboxProfile,
    });

  const request = (saved: ui.ComposerDraft, sandboxProfileId = profile.id) =>
    create(ui.CreateThreadRequestSchema, {
      projectId,
      workspaceId,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.FULL_AUTO,
      clientRequestId: saved.content!.clientRequestId,
      initialMessage: saved.content!.text,
      draftId: saved.id,
      draftRevision: saved.revision,
      sandboxProfileId,
    });

  test("an older save cannot drop the profile, while a versioned explicit clear can", async () => {
    const saved = await save(draft());

    const blank = create(ui.ComposerDraftSchema, {
      ...saved,
      content: { ...saved.content!, sandboxProfile: undefined },
    });

    expect(await failure(save(blank))).toContain("updated Canopy client");
    expect(await failure(save({ ...blank, revision: saved.revision - 1n }, true))).toContain("changed");
    expect((await save(blank, true)).content?.sandboxProfile).toBeUndefined();

    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!;
    expect(
      await failure(save({ ...draft(), target: create(ui.ComposerDraftTargetSchema, { threadId: thread.id }) })),
    ).toContain("drafts for new threads");
  });

  test("unary delivery requires the saved choice and keeps exact binding across a receipt retry", async () => {
    const saved = await save(draft());

    expect(await failure(gw.api.createThread(request(saved, "")))).toContain("Reselect the profile");
    expect(await failure(gw.api.createThread(request(saved, Bun.randomUUIDv7())))).toContain("Reselect the profile");
    expect(await failure(gw.api.createThread({ ...request(saved), permissionMode: PermissionMode.ASK }))).toContain(
      "Reselect the profile",
    );

    const original = (await gw.api.createThread(request(saved))).thread!;
    expect(original.sandboxProfile?.profile?.name).toBe(profile.name);

    await saveCatalog({ ...profile, name: "Changed after delivery" });
    const replay = (await gw.api.createThread(request(saved))).thread!;
    expect(replay.id).toBe(original.id);
    expect(replay.sandboxProfile).toEqual(original.sandboxProfile);
    await saveCatalog(profile);
  });

  test("progress delivery refuses a changed snapshot and accepts it after the owner reselects", async () => {
    const saved = await save(draft());

    const progress = async (value: ui.CreateThreadRequest) => {
      const events: ui.CreateThreadProgress[] = [];

      for await (const event of gw.api.createThreadWithProgress(value)) events.push(event);

      return events.at(-1);
    };

    expect(await progress(request(saved, ""))).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("Reselect"),
    });

    const newer = { ...profile, name: "Updated profile" };
    await saveCatalog(newer);
    expect(await progress(request(saved))).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("Reselect"),
    });

    const downstream = create(ui.CreateThreadRequestSchema, {
      ...request(saved),
      draftId: "",
      draftRevision: 0n,
      sandboxProfileDigest: "a".repeat(64),
    });

    expect(await failure(gw.api.createThread(downstream))).toContain("Reselect the profile");

    const reselected = await save(
      create(ui.ComposerDraftSchema, {
        ...saved,
        content: { ...saved.content!, sandboxProfile: create(SandboxProfileSchema, newer) },
      }),
    );

    const completed = await progress(request(reselected));
    expect(completed?.status).toBe("completed");
    expect(completed?.thread?.sandboxProfile?.profile?.name).toBe(newer.name);
  });
});

test.skipIf(!dockerAvailable)(
  "a linked home rejects a different snapshot at the point of creation",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-draft-sandbox-"));
    let fixture: Awaited<ReturnType<typeof linkedProjectFixture>> | undefined;

    try {
      fixture = await linkedProjectFixture(directory, { shared: true });
      const { a, b, lb } = fixture;
      const profile = { id: Bun.randomUUIDv7(), name: "Offline at origin", allowedDomains: [] };

      for (const [home, name] of [
        [a, profile.name],
        [b, "Different snapshot at the linked home"],
      ] as const) {
        const settings = JSON.stringify({ sandboxProfiles: { profiles: [{ ...profile, name }] } });
        await home.gw.runtime.runPromise(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql`INSERT INTO user_settings (user_id, settings, version)
            VALUES (${home.gw.userId}::uuid, ${settings}::jsonb, 1)
            ON CONFLICT (user_id) DO UPDATE SET settings=user_settings.settings || excluded.settings`,
          ),
        );
      }

      const peer = nodeRef(lb.hello().nodeId);
      const workspaceId = `${b.workspace.id}~${peer}`;
      const overview = await a.gw.api.getOverview({});

      const workspace = overview.projects
        .flatMap((project) => project.workspaces)
        .find((item) => item.id === workspaceId);

      if (!workspace) throw new Error("The linked workspace is missing from the overview.");
      const target = { projectId: workspace.projectId, workspaceId };
      const clientRequestId = Bun.randomUUIDv7();

      const saved = await a.gw.api.saveComposerDraft({
        draft: {
          id: Bun.randomUUIDv7(),
          deviceId: "desktop",
          deviceName: "Desktop",
          target,
          content: {
            text: "Send with the saved snapshot.",
            clientRequestId,
            sandboxProfile: profile,
          },
        },
        mutationId: Bun.randomUUIDv7(),
      });

      let receivedAtHome = "";
      const createThread = b.gw.core.createThread;
      b.gw.core.createThread = (input, ...args) => {
        receivedAtHome = input.sandboxProfileDigest;

        return createThread.call(b.gw.core, input, ...args);
      };

      expect(
        await failure(
          a.gw.api.createThread({
            ...target,
            provider: Provider.CODEX,
            permissionMode: PermissionMode.FULL_AUTO,
            sandboxProfileId: profile.id,
            clientRequestId,
            initialMessage: saved.content!.text,
            draftId: saved.id,
            draftRevision: saved.revision,
          }),
        ),
      ).toContain("Reselect the profile");

      expect(receivedAtHome).toHaveLength(64);
      expect((await b.gw.api.listThreads({ projectId: b.project.id })).threads).toHaveLength(0);
    } finally {
      await fixture?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
