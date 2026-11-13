import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clone, create, fromBinary } from "@bufbuild/protobuf";
import { MentionKind, Provider, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { composerDraftStore } from "../../apps/gateway/src/drafts/store.ts";
import { listComposerDrafts, pruneComposerDrafts } from "../../apps/gateway/src/drafts/query.ts";
import { subscribeDrafts } from "../../apps/gateway/src/drafts/events.ts";
import { startTestGateway, failure, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("owner composer drafts", () => {
  let gw: TestGateway;
  let threadId: string;
  let other: string;
  beforeAll(async () => {
    gw = await startTestGateway();
    other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("draft-other@example.test", "Other")));
    const overview = await gw.api.getOverview({});
    const project = overview.projects[0];
    const workspace = project?.workspaces[0];

    if (!project || !workspace) throw new Error("Missing test workspace");

    const result = await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
    });

    if (!result.thread) throw new Error("Missing test thread");
    threadId = result.thread.id;
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
      content: {
        text: "Continue this prompt",
        clientRequestId: crypto.randomUUID(),
        model: "gpt-6.1-sol",
        effort: "high",
      },
    });

  const save = (value = draft()) => gw.api.saveComposerDraft({ draft: value, mutationId: crypto.randomUUID() });

  test("saves are revision checked, retry idempotent, private and absent from worker commands", async () => {
    const request = { draft: draft(), mutationId: crypto.randomUUID() };
    const saved = await gw.api.saveComposerDraft(request);
    expect(await gw.api.saveComposerDraft(request)).toEqual(saved);
    expect(await failure(gw.api.saveComposerDraft({ ...request, mutationId: crypto.randomUUID() }))).toContain(
      "changed",
    );
    const visible = await gw.api.listComposerDrafts({ deviceId: "desktop" });
    expect(visible.drafts.some((d) => d.id === saved.id)).toBe(true);
    expect((await gw.api.listComposerDrafts({ deviceId: "phone" })).drafts).toEqual([]);

    const foreign = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* listComposerDrafts(sql, other, create(ui.ListComposerDraftsRequestSchema));
      }),
    );

    expect(foreign.drafts).toEqual([]);
    expect(
      await failure(
        gw.runtime.runPromise(
          Effect.gen(function* () {
            return yield* composerDraftStore(yield* SqlClient.SqlClient, other).continue(
              create(ui.ContinueComposerDraftRequestSchema, {
                id: saved.id,
                expectedRevision: saved.revision,
                deviceId: "foreign",
                deviceName: "Other",
                mutationId: "foreign-claim",
              }),
            );
          }),
        ),
      ),
    ).toContain("not found");
    expect(
      await failure(
        gw.runtime.runPromise(
          Effect.gen(function* () {
            return yield* composerDraftStore(yield* SqlClient.SqlClient, other).save(
              create(ui.SaveComposerDraftRequestSchema, {
                draft: { ...saved, revision: 0n },
                mutationId: "foreign-save",
              }),
            );
          }),
        ),
      ),
    ).toContain("not found");
    expect(gw.worker.inputs.size).toBe(0);
  });

  test("a concurrent continue has one winner; retries do not append twice and the source cannot send", async () => {
    const original = { draft: draft(), mutationId: crypto.randomUUID() };
    const saved = await gw.api.saveComposerDraft(original);

    const requests = ["mac", "tablet"].map((deviceId) => ({
      id: saved.id,
      expectedRevision: saved.revision,
      deviceId,
      deviceName: deviceId,
      mutationId: crypto.randomUUID(),
    }));

    const results = await Promise.allSettled(requests.map((r) => gw.api.continueComposerDraft(r)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    const claimed = await gw.api.continueComposerDraft(requests[winner]!);
    const expected = clone(ui.ComposerDraftContentSchema, saved.content ?? create(ui.ComposerDraftContentSchema));
    expected.clientRequestId = claimed.content?.clientRequestId ?? "";
    expect(claimed.content).toEqual(expected);
    expect(claimed.content?.clientRequestId).not.toBe(saved.content?.clientRequestId);
    expect(claimed.revision).toBe(saved.revision + 1n);
    expect(await failure(gw.api.saveComposerDraft(original))).toContain("changed");
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === saved.id)).toBe(
      false,
    );
    expect(
      await failure(
        gw.api.sendMessage({
          threadId,
          text: "stale",
          clientRequestId: saved.content?.clientRequestId ?? "",
          draftId: saved.id,
          draftRevision: saved.revision,
        }),
      ),
    ).toContain("changed");

    const outgoing = {
      threadId,
      text: claimed.content?.text ?? "",
      clientRequestId: claimed.content?.clientRequestId ?? "",
      draftId: claimed.id,
      draftRevision: claimed.revision,
    };

    const sent = await gw.api.sendMessage(outgoing);
    expect((await gw.api.sendMessage(outgoing)).turn?.id).toBe(sent.turn?.id);
    expect(await failure(gw.api.sendMessage({ ...outgoing, text: "Different payload" }))).toContain("changed");

    // A forks its retained local text after B's claim, with fresh draft and send identities.
    const fork = create(ui.ComposerDraftSchema, {
      ...saved,
      id: crypto.randomUUID(),
      revision: 0n,
      content: create(ui.ComposerDraftContentSchema, {
        ...(saved.content ?? create(ui.ComposerDraftContentSchema)),
        clientRequestId: crypto.randomUUID(),
      }),
    });

    const savedFork = await save(fork);

    const resent = await gw.api.sendMessage({
      threadId,
      text: fork.content?.text ?? "",
      clientRequestId: fork.content?.clientRequestId ?? "",
      draftId: savedFork.id,
      draftRevision: savedFork.revision,
    });

    expect(resent.turn?.id).toBeTruthy();
  });

  test("a definite rejection rolls back the send fence; edited content sends without another save", async () => {
    const saved = await save();
    await gw.api.setThreadArchived({ threadId, archived: true });
    expect(
      await failure(
        gw.api.sendMessage({
          threadId,
          text: "Edited locally",
          clientRequestId: saved.content?.clientRequestId ?? "",
          draftId: saved.id,
          draftRevision: saved.revision,
        }),
      ),
    ).toContain("archived");
    await gw.api.setThreadArchived({ threadId, archived: false });

    const sent = await gw.api.sendMessage({
      threadId,
      text: "Edited locally",
      clientRequestId: saved.content?.clientRequestId ?? "",
      draftId: saved.id,
      draftRevision: saved.revision,
    });

    expect(sent.turn?.id).toBeTruthy();
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql<{
          payload: Uint8Array;
          send_request: Uint8Array;
          send_result: Uint8Array | null;
        }>`SELECT payload,send_request,send_result FROM composer_drafts WHERE id=${saved.id}::uuid`;

        expect(rows[0]?.payload.length).toBe(0);
        expect(rows[0]?.send_request.length).toBe(32);
        expect(rows[0]?.send_result).toBeNull();
        yield* pruneComposerDrafts(sql, gw.userId);
        expect(yield* sql`SELECT id FROM composer_drafts WHERE id=${saved.id}::uuid`).toHaveLength(1);
        yield* sql`UPDATE composer_drafts SET expires_at=now()-interval '1 day' WHERE id=${saved.id}::uuid`;
        yield* pruneComposerDrafts(sql, gw.userId);
        expect(yield* sql`SELECT id FROM composer_drafts WHERE id=${saved.id}::uuid`).toHaveLength(0);
      }),
    );
  });

  test("sending never waits for a draft save, and a late save cannot resurrect the sent prompt", async () => {
    for (const order of ["send-first", "save-first", "concurrent"] as const) {
      const value = draft();

      const request = {
        threadId,
        text: "Prompt edited while handoff was saving",
        clientRequestId: value.content?.clientRequestId ?? "",
        draftId: value.id,
      };

      if (order === "save-first") await save(value);

      const [sent] = await Promise.all([
        gw.api.sendMessage(request),
        order === "concurrent" ? save(value).catch(() => undefined) : Promise.resolve(),
      ]);

      expect(sent.turn?.id).toBeTruthy();
      expect(await gw.api.sendMessage(request)).toEqual(sent);
      expect(await failure(save(value))).toContain("changed");
      expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === value.id)).toBe(
        false,
      );
    }

    const saved = await save();
    await gw.api.saveComposerDraft({ draft: saved, expectedRevision: saved.revision, mutationId: crypto.randomUUID() });

    const sent = await gw.api.sendMessage({
      threadId,
      text: "The save response is still in flight",
      draftId: saved.id,
      draftRevision: saved.revision,
      clientRequestId: saved.content?.clientRequestId ?? "",
    });

    expect(sent.turn?.id).toBeTruthy();
  });

  test("watch resumes from the owner clock and wakes on writes", async () => {
    const page = await gw.api.listComposerDrafts({ deviceId: "desktop" });
    const abort = new AbortController();

    const watch = gw.api
      .watchComposerDrafts({ afterRevision: page.changeRevision }, { signal: abort.signal })
      [Symbol.asyncIterator]();

    const next = watch.next();
    await save();
    expect((await next).value?.revision).toBeGreaterThan(page.changeRevision);
    abort.abort();
    await watch.return?.();
  });

  test("unsaved send receipts never advance or wake the drafts list and recover from native admission", async () => {
    const before = await gw.api.listComposerDrafts({ deviceId: "desktop" });
    const subscription = subscribeDrafts(gw.core);

    const request = {
      threadId,
      text: "An ordinary send without handoff",
      draftId: crypto.randomUUID(),
      clientRequestId: crypto.randomUUID(),
    };

    const recovery = { id: request.draftId, threadId, clientRequestId: request.clientRequestId };

    try {
      expect((await gw.api.getComposerDraftDelivery(recovery)).confirmed).toBe(false);
      await gw.api.sendMessage(request);
      expect((await gw.api.getComposerDraftDelivery(recovery)).confirmed).toBe(true);
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Simulate process loss between native admission and receipt settlement.
          yield* sql`UPDATE composer_drafts SET sent=false,sending_request_id=${request.clientRequestId},
          send_active_until=now()+interval '5 minutes' WHERE id=${request.draftId}::uuid`;
        }),
      );
      expect((await gw.api.getComposerDraftDelivery(recovery)).confirmed).toBe(true);
      expect(
        (await gw.api.getComposerDraftDelivery({ ...recovery, clientRequestId: "another-request" })).confirmed,
      ).toBe(false);
      expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).changeRevision).toBe(before.changeRevision);
      expect(subscription.channel.queuedItems).toBe(0);
    } finally {
      subscription.close();
    }
  });

  test("creation recovery waits for the initial message rather than the thread row alone", async () => {
    const overview = await gw.api.getOverview({});
    const project = overview.projects[0];
    const workspace = project?.workspaces[0];

    if (!project || !workspace) throw new Error("Missing test workspace");
    const clientRequestId = crypto.randomUUID();

    const created = await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      clientRequestId,
    });

    const recovery = { id: crypto.randomUUID(), clientRequestId };
    expect((await gw.api.getComposerDraftDelivery(recovery)).confirmed).toBe(false);
    await gw.api.sendMessage({ threadId: created.thread?.id ?? "", text: "Initial message admitted", clientRequestId });
    expect((await gw.api.getComposerDraftDelivery(recovery)).confirmed).toBe(true);
  });

  test.each(["message", "goal"])(
    "a failed %s settlement recovers from native admission and clears retained payload",
    async (kind) => {
      const saved = await save();

      const request = {
        threadId,
        text: kind === "goal" ? "/goal Admission survives receipt failure" : "Admission survives receipt failure",
        mentions:
          kind === "goal" ? [{ kind: MentionKind.COMMAND, name: "goal", source: "platform", start: 0, end: 5 }] : [],
        draftId: saved.id,
        draftRevision: saved.revision,
        clientRequestId: saved.content?.clientRequestId ?? "",
      };

      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE FUNCTION reject_draft_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic receipt write failure'; END; $$`;
          yield* sql`CREATE TRIGGER reject_draft_settlement BEFORE UPDATE ON composer_drafts
        FOR EACH ROW WHEN (NEW.sent) EXECUTE FUNCTION reject_draft_settlement()`;
        }),
      );

      try {
        expect(await failure(gw.api.sendMessage(request))).toContain("not confirmed");
      } finally {
        await gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER reject_draft_settlement ON composer_drafts`;
            yield* sql`DROP FUNCTION reject_draft_settlement()`;
          }),
        );
      }

      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const receipts = yield* sql<{ response: Uint8Array }>`SELECT response FROM thread_message_receipts
        WHERE thread_id=${threadId}::uuid AND client_request_id=${request.clientRequestId}`;

          expect(receipts).toHaveLength(1);
          const result = fromBinary(ui.SendMessageResponseSchema, receipts[0]!.response);

          expect(kind === "goal" ? result.goal : result.turn).toBeDefined();
        }),
      );

      expect(
        await gw.api.getComposerDraftDelivery({
          id: saved.id,
          threadId,
          clientRequestId: request.clientRequestId,
        }),
      ).toMatchObject({ confirmed: true, inFlight: false });
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* sql<{ sent: boolean; bytes: number }>`SELECT sent,octet_length(payload) AS bytes
        FROM composer_drafts WHERE id=${saved.id}::uuid`;

          expect(rows[0]).toEqual({ sent: true, bytes: 0 });
          expect(
            yield* sql`SELECT id FROM turns WHERE thread_id=${threadId}::uuid
        AND client_request_id=${request.clientRequestId}`,
          ).toHaveLength(kind === "goal" ? 0 : 1);
          expect(
            yield* sql`SELECT id FROM turn_steers WHERE thread_id=${threadId}::uuid
        AND client_request_id=${request.clientRequestId}`,
          ).toHaveLength(0);
        }),
      );
    },
  );

  test("Internal and FailedPrecondition rejections leave drafts editable and removable", async () => {
    const send = gw.core.sendMessage;

    for (const code of [Code.Internal, Code.FailedPrecondition]) {
      const saved = await save();
      gw.core.sendMessage = async () => {
        throw new ConnectError("Send rejected", code);
      };

      try {
        expect(
          await failure(
            gw.api.sendMessage({
              threadId,
              text: "Prompt",
              clientRequestId: saved.content?.clientRequestId ?? "",
              draftId: saved.id,
              draftRevision: saved.revision,
            }),
          ),
        ).toContain("Send rejected");
      } finally {
        gw.core.sendMessage = send;
      }

      const edited = await gw.api.saveComposerDraft({
        draft: saved,
        expectedRevision: saved.revision,
        mutationId: crypto.randomUUID(),
      });

      await gw.api.deleteComposerDraft({ id: edited.id, expectedRevision: edited.revision, deviceId: edited.deviceId });
    }
  });

  test("an unknown outcome fences claims until retry or explicit owner discard, including unsaved sends", async () => {
    const send = gw.core.sendMessage;

    for (const published of [false, true]) {
      const value = published ? await save() : draft();

      const request = {
        threadId,
        text: value.content?.text ?? "",
        clientRequestId: value.content?.clientRequestId ?? "",
        draftId: value.id,
        draftRevision: value.revision,
      };

      gw.core.sendMessage = async () => {
        throw new ConnectError("Remote acknowledgment lost", Code.DeadlineExceeded);
      };

      try {
        expect(await failure(gw.api.sendMessage(request))).toContain("Remote acknowledgment lost");
        // Both saved and unsaved fences must permit retrying the exact request.
        expect(await failure(gw.api.sendMessage(request))).toContain("Remote acknowledgment lost");
      } finally {
        gw.core.sendMessage = send;
      }

      expect(
        await failure(
          gw.api.continueComposerDraft({
            id: value.id,
            expectedRevision: value.revision || 1n,
            deviceId: "desktop",
            deviceName: "Desktop",
            mutationId: crypto.randomUUID(),
          }),
        ),
      ).toContain("changed");
      expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === value.id)).toBe(
        false,
      );
      expect(
        await failure(
          gw.api.saveComposerDraft({ draft: value, expectedRevision: value.revision, mutationId: crypto.randomUUID() }),
        ),
      ).toContain("changed");
      await gw.api.deleteComposerDraft({ id: value.id, expectedRevision: value.revision, deviceId: value.deviceId });
      expect(
        await failure(
          gw.api.continueComposerDraft({
            id: value.id,
            deviceId: "desktop",
            deviceName: "Desktop",
            mutationId: crypto.randomUUID(),
          }),
        ),
      ).toContain("not found");
    }
  });

  test("in-flight sends are absent from lists and retention preserves send fences", async () => {
    const saved = await save();
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE composer_drafts SET sending_request_id='pending',expires_at=now()-interval '1 day' WHERE id=${saved.id}::uuid`;
        yield* pruneComposerDrafts(sql, gw.userId);
        expect(yield* sql`SELECT id FROM composer_drafts WHERE id=${saved.id}::uuid`).toHaveLength(1);
        yield* sql`UPDATE composer_drafts SET expires_at=now()+interval '1 day' WHERE id=${saved.id}::uuid`;
      }),
    );
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((row) => row.id === saved.id)).toBe(
      false,
    );
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM composer_drafts WHERE id=${saved.id}::uuid`;
      }),
    );
  });

  test("new-thread handoff creates one thread and one initial turn when two retries race", async () => {
    const overview = await gw.api.getOverview({});
    const project = overview.projects[0];
    const workspace = project?.workspaces[0];

    if (!project || !workspace) throw new Error("Missing workspace");
    const source = draft();
    source.target = create(ui.ComposerDraftTargetSchema, { projectId: project.id, workspaceId: workspace.id });
    const saved = await save(source);

    const claimed = await gw.api.continueComposerDraft({
      id: saved.id,
      expectedRevision: saved.revision,
      deviceId: "desktop",
      deviceName: "Mac",
      mutationId: "take-new-thread",
    });

    const request = {
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      initialMessage: claimed.content?.text ?? "",
      clientRequestId: claimed.content?.clientRequestId ?? "",
      draftId: claimed.id,
      draftRevision: claimed.revision,
    };

    const [first, second] = await Promise.all([gw.api.createThread(request), gw.api.createThread(request)]);
    expect(first.thread?.id).toBe(second.thread?.id);
    expect(first.thread?.id).toBeTruthy();

    const turns = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT id FROM turns WHERE thread_id=${first.thread?.id ?? ""}::uuid AND client_request_id=${request.clientRequestId}`;
      }),
    );

    expect(turns).toHaveLength(1);
  });

  test("unsaved creation races a first handoff save without waiting or recreating its draft", async () => {
    const project = (await gw.api.getOverview({})).projects[0];
    const workspace = project?.workspaces[0];

    if (!project || !workspace) throw new Error("Missing workspace");
    const value = draft();
    value.target = create(ui.ComposerDraftTargetSchema, { projectId: project.id, workspaceId: workspace.id });

    const request = {
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      initialMessage: value.content?.text ?? "",
      clientRequestId: value.content?.clientRequestId ?? "",
      draftId: value.id,
    };

    const [sent] = await Promise.all([gw.api.createThread(request), save(value).catch(() => undefined)]);
    expect(sent.thread?.id).toBeTruthy();
    expect((await gw.api.createThread(request)).thread?.id).toBe(sent.thread?.id);
    expect(await failure(save(value))).toContain("changed");
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === value.id)).toBe(
      false,
    );
  });

  test("oversized drafts are refused before storage", async () => {
    const source = draft();

    if (!source.content) throw new Error("Missing content");
    source.content.text = "x".repeat(100001);
    expect(await failure(save(source))).toContain("large");
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === source.id)).toBe(
      false,
    );
  });

  test("pages are bounded, changes are monotonic, expiration drops attachment references", async () => {
    const file = (
      await gw.api.uploadAttachment({ name: "draft.txt", data: new TextEncoder().encode("draft attachment") })
    ).attachment;

    if (!file) throw new Error("Missing test attachment");

    const saved = await save(
      create(ui.ComposerDraftSchema, {
        ...draft(),
        content: create(ui.ComposerDraftContentSchema, {
          ...(draft().content ?? create(ui.ComposerDraftContentSchema)),
          attachments: [file],
        }),
      }),
    );

    const page = await gw.api.listComposerDrafts({ deviceId: "desktop", pageSize: 1 });
    expect(page.drafts).toHaveLength(1);
    expect(page.nextPageToken).not.toBe("");
    const next = await gw.api.listComposerDrafts({ deviceId: "desktop", pageSize: 1, pageToken: page.nextPageToken });
    expect(next.drafts[0]?.id).not.toBe(page.drafts[0]?.id);
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE composer_drafts SET expires_at=now()-interval '1 day' WHERE id=${saved.id}::uuid`;
        yield* pruneComposerDrafts(sql, gw.userId);
        const refs = yield* sql`SELECT * FROM composer_draft_attachments WHERE draft_id=${saved.id}::uuid`;
        expect(refs).toEqual([]);
        const files = yield* sql`SELECT id FROM attachments WHERE id=${file.id}::uuid`;
        expect(files).toHaveLength(1);
      }),
    );
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).changeRevision).toBeGreaterThan(
      page.changeRevision,
    );
  });

  test("archive keeps drafts; deleting a thread removes drafts and their attachment references", async () => {
    const saved = await save();
    await gw.api.setThreadArchived({ threadId, archived: true });
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts.some((d) => d.id === saved.id)).toBe(true);

    const results = await Promise.allSettled([
      gw.api.saveComposerDraft({
        draft: saved,
        expectedRevision: saved.revision,
        mutationId: crypto.randomUUID(),
      }),
      gw.api.deleteThread({ threadId }),
    ]);

    expect(results[1]?.status).toBe("fulfilled");
    expect((await gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts).toEqual([]);
  });
});
