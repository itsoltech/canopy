import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { ComposerSync } from "@canopy/domain/composer-sync";
import { MobileRemoteDrafts } from "../../apps/mobile/src/features/drafts/remote.ts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { listComposerDrafts } from "../../apps/gateway/src/drafts/query.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("automatic composer sync and take-over receipts", () => {
  let gw: TestGateway;
  let threadId: string;
  beforeAll(async () => {
    gw = await startTestGateway();
    const project = (await gw.api.getOverview({})).projects[0];
    const workspace = project?.workspaces[0];

    if (!project || !workspace) throw new Error("Missing workspace");

    const thread = (
      await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread;

    if (!thread) throw new Error("Missing thread");
    threadId = thread.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  const draft = () =>
    create(ui.ComposerDraftSchema, {
      id: crypto.randomUUID(),
      deviceId: "phone",
      deviceName: "iPhone",
      target: { threadId },
      content: { text: "Unfinished prompt", clientRequestId: crypto.randomUUID() },
    });

  const save = (value: ui.ComposerDraft) =>
    gw.api.saveComposerDraft({ draft: value, expectedRevision: value.revision, mutationId: crypto.randomUUID() });

  const take = (value: ui.ComposerDraft) =>
    gw.api.continueComposerDraft({
      id: value.id,
      expectedRevision: value.revision,
      deviceId: "desktop",
      deviceName: "Mac",
      mutationId: crypto.randomUUID(),
    });

  test("an open list transaction does not block sending the listed draft", async () => {
    const original = await save(draft());
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const page = yield* listComposerDrafts(
              sql,
              gw.userId,
              create(ui.ListComposerDraftsRequestSchema, { deviceId: "desktop", threadId }),
            );

            expect(page.drafts.some((row) => row.id === original.id)).toBe(true);

            const sent = yield* Effect.tryPromise(() =>
              gw.api.sendMessage(
                {
                  threadId,
                  text: original.content?.text ?? "",
                  clientRequestId: original.content?.clientRequestId ?? "",
                  draftId: original.id,
                  draftRevision: original.revision,
                },
                { timeoutMs: 2000 },
              ),
            );

            expect(sent.turn?.id).toBeTruthy();
          }),
        );
      }),
    );
  });

  test("oversized source receipt requests are truncated without breaking draft lists", async () => {
    const original = await save(draft());
    await take(original);

    const page = await gw.api.listComposerDrafts({
      deviceId: "phone",
      sourceDraftIds: [
        original.id,
        ...Array.from({ length: 99 }, () => crypto.randomUUID()),
        "ignored-invalid-overflow",
      ],
    });

    expect(page.moves.some((move) => move.id === original.id)).toBe(true);
  });

  test("a typing burst sends one save RPC; blur flushes once and clearing removes the remote draft", async () => {
    let current = draft();
    let writes = 0;

    const sync = new ComposerSync(async () => {
      writes++;
      current = await save(current);
    }, 40);

    try {
      for (const text of ["A", "An", "An unfinished", "An unfinished prompt"]) {
        if (current.content) current.content.text = text;
        sync.update(text);
      }

      expect(writes).toBe(0);
      await Bun.sleep(100);
      expect(writes).toBe(1);
      expect(
        (await gw.api.listComposerDrafts({ deviceId: "desktop", threadId })).drafts.find((row) => row.id === current.id)
          ?.content?.text,
      ).toBe("An unfinished prompt");

      if (current.content) current.content.text += " with edits";
      sync.update(current.content?.text ?? "");
      await sync.flush();
      await Bun.sleep(80);
      expect(writes).toBe(2);
      await gw.api.deleteComposerDraft({ id: current.id, expectedRevision: current.revision, deviceId: "phone" });
      expect(
        (await gw.api.listComposerDrafts({ deviceId: "desktop", threadId })).drafts.some(
          (row) => row.id === current.id,
        ),
      ).toBe(false);
    } finally {
      sync.cancel();
    }
  });

  test("take-over notifies the source even after the receiver saves and sends; receipts are owner scoped", async () => {
    const original = await save(draft());
    const before = (await gw.api.listComposerDrafts({ deviceId: "phone" })).changeRevision;
    const claimed = await take(original);
    const received = await save(create(ui.ComposerDraftSchema, { ...claimed, deviceId: "desktop", deviceName: "Mac" }));
    await gw.api.sendMessage({
      threadId,
      text: received.content?.text ?? "",
      clientRequestId: received.content?.clientRequestId ?? "",
      draftId: received.id,
      draftRevision: received.revision,
    });
    const page = await gw.api.listComposerDrafts({ deviceId: "phone", sourceDraftIds: [original.id] });
    expect(page.moves).toEqual([
      create(ui.ComposerDraftMoveSchema, { id: original.id, sourceRevision: original.revision, deviceName: "Mac" }),
    ]);
    expect(page.changeRevision).toBeGreaterThan(before);
    expect((await gw.api.listComposerDrafts({ deviceId: "other", sourceDraftIds: [original.id] })).moves).toEqual([]);

    const other = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("sync-other@example.test", "Other")),
    );

    const foreign = await gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* listComposerDrafts(
          yield* SqlClient.SqlClient,
          other,
          create(ui.ListComposerDraftsRequestSchema, { deviceId: "phone", sourceDraftIds: [original.id] }),
        );
      }),
    );

    expect(foreign.moves).toEqual([]);
    expect(foreign.threadIds).toEqual([]);
  });

  test("a source edit racing take-over has one winner and a revision receipt preserves later local edits", async () => {
    const original = await save(draft());

    const edited = create(ui.ComposerDraftSchema, {
      ...original,
      content: create(ui.ComposerDraftContentSchema, {
        ...(original.content ?? create(ui.ComposerDraftContentSchema)),
        text: "New source edits",
      }),
    });

    const results = await Promise.allSettled([save(edited), take(original)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const page = await gw.api.listComposerDrafts({ deviceId: "phone", sourceDraftIds: [original.id] });

    if (results[0]?.status === "fulfilled") {
      expect(page.moves).toEqual([]);
      const rows = (await gw.api.listComposerDrafts({ deviceId: "desktop", threadId })).drafts;
      expect(rows.find((row) => row.id === original.id)?.content?.text).toBe("New source edits");
    } else {
      expect(page.moves[0]?.sourceRevision).toBe(original.revision);

      const fork = create(ui.ComposerDraftSchema, {
        ...edited,
        id: crypto.randomUUID(),
        revision: 0n,
        content: create(ui.ComposerDraftContentSchema, {
          ...(edited.content ?? create(ui.ComposerDraftContentSchema)),
          clientRequestId: crypto.randomUUID(),
        }),
      });

      expect((await save(fork)).content?.text).toBe("New source edits");
    }
  });

  test("a source send racing take-over cannot deliver the same draft twice", async () => {
    const original = await save(draft());

    const results = await Promise.allSettled([
      gw.api.sendMessage({
        threadId,
        text: original.content?.text ?? "",
        clientRequestId: original.content?.clientRequestId ?? "",
        draftId: original.id,
        draftRevision: original.revision,
      }),
      take(original),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const page = await gw.api.listComposerDrafts({ deviceId: "phone", sourceDraftIds: [original.id] });
    expect(page.moves.length).toBe(results[1]?.status === "fulfilled" ? 1 : 0);
  });

  test("an invalidation during a page read still delivers the take-over receipt", async () => {
    const original = await save(draft());
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const api = {
      ...gw.api,
      listComposerDrafts: async (...args: Parameters<typeof gw.api.listComposerDrafts>) => {
        const page = await gw.api.listComposerDrafts(...args);
        captured.resolve();
        await release.promise;

        return page;
      },
    };

    const remote = new MobileRemoteDrafts();
    const pending = remote.load(api, "phone", false, [original.id]);

    try {
      await captured.promise;
      await take(original);
      remote.invalidate();
    } finally {
      release.resolve();
    }

    expect((await pending).moves.some((move) => move.id === original.id)).toBe(true);
  });
});
