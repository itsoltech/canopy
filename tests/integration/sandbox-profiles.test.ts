import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SANDBOX_PROFILES_CAPABILITY } from "@canopy/domain/sandbox-profiles";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread sandbox profiles", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const profile = { id: Bun.randomUUIDv7(), name: "Offline", allowedDomains: [] };

  const saveProfiles = async (profiles: (typeof profile)[]) => {
    const { user } = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: user!.version, sandboxProfiles: { profiles } });
  };

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: {
        hello: { capabilities: [SANDBOX_PROFILES_CAPABILITY, "thread_resource_cleanup_v1"] },
        sandboxOffline: true,
      },
    });

    const configured = await eventually(
      () => gw.api.getOverview({}),
      (overview) => overview.workers.some((w) => w.profiles.some((p) => p.sandboxSupport?.offline)),
    );

    expect(configured.workers.some((w) => w.profiles.some((p) => p.sandboxSupport?.offline))).toBe(true);
    projectId = (await gw.api.createProject({ name: "Sandbox profiles" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/sandbox" }))
      .workspace!.id;
    await saveProfiles([profile]);
  }, 60_000);

  afterAll(async () => gw?.close());

  const request = () => ({
    projectId,
    workspaceId,
    provider: Provider.CODEX,
    permissionMode: PermissionMode.FULL_AUTO,
  });

  const get = async (threadId: string) => (await gw.api.getThread({ threadId })).thread!;

  const ready = async (threadId: string) => {
    const result = await eventually(
      () => get(threadId),
      (thread) => thread.status === "idle",
    );

    expect(result.status).toBe("idle");
  };

  test("persists the selection snapshot and sends only the fenced worker payload", async () => {
    const bound = (await gw.api.createThread({ ...request(), sandboxProfileId: profile.id })).thread!;
    await ready(bound.id);
    expect(bound.sandboxProfile?.profile?.name).toBe(profile.name);
    const digest = bound.sandboxProfile!.digest;

    const create = gw.worker.commands.find(
      (command) => command.case === "createThread" && command.value.profiledThread?.thread?.threadId === bound.id,
    );

    expect(create?.case).toBe("createThread");

    if (create?.case === "createThread") {
      expect(create.value.thread).toBeUndefined();
      expect(create.value.profiledThread?.thread?.sandboxProfile).toBeUndefined();
      expect(create.value.profiledThread?.binding?.digest).toBe(digest);
    }

    await saveProfiles([{ ...profile, name: "Changed" }]);
    expect((await get(bound.id)).sandboxProfile?.profile?.name).toBe("Offline");
    await saveProfiles([]);
    expect((await get(bound.id)).sandboxProfile?.digest).toBe(digest);
    expect(await failure(gw.api.sendMessage({ threadId: bound.id, text: "!echo unsafe" }))).toContain("Composer shell");
    expect(
      await failure(gw.api.updateThread({ threadId: bound.id, permissionMode: PermissionMode.FULL_ACCESS })),
    ).toContain("Choose Sandbox");
    expect(await failure(gw.api.createThread({ ...request(), parentThreadId: bound.id }))).toContain("sandbox profile");
    const sent = (await gw.api.sendMessage({ threadId: bound.id, text: "Continue" })).turn!;

    const start = await eventually(
      async () => gw.worker.commands.find((c) => c.case === "startTurn" && c.value.turnId === sent.id),
      (command) => command !== undefined,
    );

    expect(start?.case).toBe("startTurn");

    if (start?.case === "startTurn") {
      expect(start.value.thread).toBeUndefined();
      expect(start.value.profiledThread?.binding?.digest).toBe(digest);
    }
  });

  test("an idle update commits after the unload acknowledgement", async () => {
    await saveProfiles([profile]);
    const thread = (await gw.api.createThread(request())).thread!;
    await ready(thread.id);
    const unload = Promise.withResolvers<() => void>();
    let acknowledged = false;
    gw.worker.handlers.set("unloadThread", (_value, reply) =>
      unload.resolve(() => {
        if (acknowledged) return;
        acknowledged = true;
        reply(true);
      }),
    );
    const update = gw.api.updateThread({ threadId: thread.id, sandboxProfileId: profile.id });

    try {
      const release = await Promise.race([unload.promise, update.then(() => undefined)]);
      expect(release).toBeDefined();
      expect((await get(thread.id)).sandboxProfile).toBeUndefined();
      release?.();
      expect((await update).thread?.sandboxProfile?.profile?.id).toBe(profile.id);
    } finally {
      gw.worker.handlers.delete("unloadThread");
      void unload.promise.then((release) => release());
      await update.catch(() => undefined);
    }

    expect(
      (await gw.api.updateThread({ threadId: thread.id, sandboxProfileId: "" })).thread?.sandboxProfile,
    ).toBeUndefined();
  });

  test("keeps steered input queued and refuses converting it into a composer shell command", async () => {
    const thread = (await gw.api.createThread({ ...request(), sandboxProfileId: profile.id })).thread!;
    await ready(thread.id);
    gw.worker.holdTurns = true;
    const running = (await gw.api.sendMessage({ threadId: thread.id, text: "Running" })).turn!;

    try {
      const started = await eventually(async () => gw.worker.started.has(running.id), Boolean);
      expect(started).toBe(true);

      const response = await gw.api.sendMessage({
        threadId: thread.id,
        text: "Keep this queued",
        delivery: ui.MessageDelivery.STEER,
      });

      expect(response.steer).toBeUndefined();
      const queued = response.turn!;
      expect(
        await failure(
          gw.api.editQueuedTurn({
            turnId: queued.id,
            text: "!echo unsafe",
            expectedRevision: queued.revision,
          }),
        ),
      ).toContain("Composer shell");
      expect(await failure(gw.api.updateThread({ threadId: thread.id, sandboxProfileId: "" }))).toContain(
        "active and queued work",
      );
    } finally {
      gw.worker.holdTurns = false;
      gw.worker.finish(thread.id, running.id);
      await ready(thread.id);
    }
  });

  test("replay refuses a saved start after downgrade without sending a legacy thread spec", async () => {
    const thread = (await gw.api.createThread({ ...request(), sandboxProfileId: profile.id })).thread!;
    await ready(thread.id);
    const admitted = Promise.withResolvers<void>();
    gw.worker.handlers.set("startTurn", () => admitted.resolve());
    const turn = (await gw.api.sendMessage({ threadId: thread.id, text: "Replay" })).turn!;

    try {
      await admitted.promise;

      const legacy = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
        hello: { capabilities: [] },
        resumeJournal: true,
      });

      const outcome = await eventually(
        () =>
          gw.runtime.runPromise(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql<{
                  status: string;
                  error_code: string;
                }>`SELECT status,error_code FROM turns WHERE id=${turn.id}::uuid`,
            ),
          ),
        (rows) => rows[0]?.status === "failed",
      );

      expect(outcome[0]?.error_code).toBe("SANDBOX_PROFILE_UNAVAILABLE");
      expect(legacy.commands.some((c) => c.case === "startTurn" && c.value.turnId === turn.id)).toBe(false);
      expect(await failure(gw.api.createThread({ ...request(), sandboxProfileId: profile.id }))).toContain("update");
    } finally {
      gw.worker.handlers.delete("startTurn");
    }
  });
});
