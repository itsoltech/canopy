import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { nodeRef } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { failure } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "a slow linked draft send releases its home connection and permits writes to the same thread",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-draft-slow-link-"));
    let fixture: Awaited<ReturnType<typeof linkedProjectFixture>> | undefined;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      fixture = await linkedProjectFixture(directory);
      const { a, b, lb } = fixture;

      const thread = (
        await b.gw.api.createThread({ projectId: b.project.id, workspaceId: b.workspace.id, provider: Provider.CODEX })
      ).thread;

      if (!thread) throw new Error("Missing thread");
      const threadId = `${thread.id}~${nodeRef(lb.hello().nodeId)}`;

      const request = {
        threadId,
        text: "A slow linked send",
        clientRequestId: crypto.randomUUID(),
        draftId: crypto.randomUUID(),
      };

      const send = b.gw.core.sendMessage;
      b.gw.core.sendMessage = async (...args) => {
        reached.resolve();
        await release.promise;

        return send.apply(b.gw.core, args);
      };

      const pending = a.gw.api.sendMessage(request);

      try {
        await reached.promise;
        expect(
          (
            await a.gw.api.getComposerDraftDelivery({
              id: request.draftId,
              threadId,
              clientRequestId: request.clientRequestId,
            })
          ).inFlight,
        ).toBe(true);

        const updated = await a.gw.api.updateThread(
          { threadId, title: "Updated while the linked send waits" },
          { timeoutMs: 2000 },
        );

        expect(updated.thread?.title).toBe("Updated while the linked send waits");
        await a.gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL lock_timeout='500ms'`;
                // The claim row is on A. Updating B alone would miss a transaction held on A.
                yield* sql`UPDATE composer_drafts SET updated_at=updated_at WHERE id=${request.draftId}::uuid`;
              }),
            );

            const open = yield* sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
              AND pid<>pg_backend_pid() AND state='idle in transaction'`;

            expect(open).toHaveLength(0);
          }),
        );

        const retry = a.gw.api.sendMessage(request);
        expect(await failure(a.gw.api.sendMessage({ ...request, text: "Different payload" }))).toContain("changed");
        release.resolve();
        const result = await pending;
        expect((await retry).turn?.id).toBe(result.turn?.id);
        expect(
          (
            await a.gw.api.getComposerDraftDelivery({
              id: request.draftId,
              threadId,
              clientRequestId: request.clientRequestId,
            })
          ).confirmed,
        ).toBe(true);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        b.gw.core.sendMessage = send;
      }
    } finally {
      release.resolve();
      await fixture?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "a lost remote send acknowledgment fences handoff and retries the same admitted message",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-draft-link-"));
    let fixture: Awaited<ReturnType<typeof linkedProjectFixture>> | undefined;

    try {
      fixture = await linkedProjectFixture(directory);
      const { a, b, lb } = fixture;

      const thread = (
        await b.gw.api.createThread({ projectId: b.project.id, workspaceId: b.workspace.id, provider: Provider.CODEX })
      ).thread;

      if (!thread) throw new Error("Missing thread");
      const threadId = `${thread.id}~${nodeRef(lb.hello().nodeId)}`;
      const requestId = crypto.randomUUID();

      const saved = await a.gw.api.saveComposerDraft({
        draft: create(ui.ComposerDraftSchema, {
          id: crypto.randomUUID(),
          deviceId: "phone",
          deviceName: "Phone",
          target: { threadId },
          content: { text: "Remote prompt", clientRequestId: requestId },
        }),
        mutationId: crypto.randomUUID(),
      });

      const request = {
        threadId,
        text: "Remote prompt",
        clientRequestId: requestId,
        draftId: saved.id,
        draftRevision: saved.revision,
      };

      const send = b.gw.core.sendMessage;
      b.gw.core.sendMessage = async (...args) => {
        await send.apply(b.gw.core, args);
        throw new ConnectError("Reply lost after admission", Code.DeadlineExceeded);
      };

      try {
        expect(await failure(a.gw.api.sendMessage(request))).toContain("not confirmed");
      } finally {
        b.gw.core.sendMessage = send;
      }

      expect(
        await failure(
          a.gw.api.continueComposerDraft({
            id: saved.id,
            expectedRevision: saved.revision,
            deviceId: "desktop",
            deviceName: "Desktop",
            mutationId: crypto.randomUUID(),
          }),
        ),
      ).toContain("changed");
      expect((await a.gw.api.listComposerDrafts({ deviceId: "desktop" })).drafts).toEqual([]);
      // A reload can recover from B's durable admission without resending the prompt.
      expect(
        (
          await a.gw.api.getComposerDraftDelivery({
            id: saved.id,
            threadId,
            clientRequestId: requestId,
          })
        ).confirmed,
      ).toBe(true);
      const result = await a.gw.api.sendMessage(request);
      expect(result.turn?.id).toBeTruthy();
      expect((await a.gw.api.sendMessage(request)).turn?.id).toBe(result.turn?.id);

      const turns = await b.gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql`SELECT id FROM turns WHERE thread_id=${thread.id}::uuid AND client_request_id=${requestId}`;
        }),
      );

      expect(turns).toHaveLength(1);
    } finally {
      await fixture?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
