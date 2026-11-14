import { expect, test } from "bun:test";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus, NoticeLevel, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import sharp from "sharp";
import { FeedBuilder } from "../../apps/web/src/lib/features/threads/feed.ts";
import { turnBody } from "../../apps/mobile/src/features/timeline/turn-plan.ts";
import { visibleTurns } from "../../apps/mobile/src/features/threads/thread-turns.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { followThread } from "./support/thread-watch.ts";

function feed(builder: FeedBuilder, snapshot: ui.ThreadSnapshot, open: boolean) {
  return builder.build({
    entries: snapshot.items.flatMap((entry) =>
      entry.item
        ? [
            {
              ...entry,
              id: entry.item.itemId,
              item: entry.item,
              completedAt: entry.completedAt ? timestampMs(entry.completedAt) : undefined,
            },
          ]
        : [],
    ),
    turns: snapshot.turns,
    notices: snapshot.notices.flatMap((notice) =>
      notice.notice ? [{ ...notice, notice: notice.notice, at: notice.occurredAt }] : [],
    ),
    results: new Map(),
    steering: [],
    working: true,
    inheritedEntries: [],
    inheritedTurns: [],
    historyOpen: false,
    openWork: new Set(open ? snapshot.turns.map((turn) => turn.id) : []),
  });
}

function assertInputFirst(builder: FeedBuilder, snapshot: ui.ThreadSnapshot, turnId: string) {
  for (const open of [false, true]) {
    const rows = feed(builder, snapshot, open);

    const inputs = rows.filter(
      (row) => row.kind === "timeline" && (row.row.kind === "input" || (row.row.kind === "item" && row.row.inputOf)),
    );

    expect(inputs).toHaveLength(1);
    expect(rows.indexOf(inputs[0]!)).toBeLessThan(rows.findIndex((row) => row.key === `work:${turnId}`));

    if (open) {
      const notice = rows.findIndex((row) => row.kind === "timeline" && row.row.kind === "notice");
      expect(notice).toBeGreaterThan(rows.indexOf(inputs[0]!));
    }
  }

  const turn = visibleTurns(snapshot).find((candidate) => candidate.id === turnId)!;
  expect(turn.messageText).toBe("Review these files");
  expect(turn.attachments.map((attachment) => attachment.name)).toEqual(["screenshot.png", "landing-copy-final.md"]);
  // Mobile renders this persisted TurnInput before turnBody, excluding the provider's echo.
  expect(
    turnBody(turn, snapshot.items, snapshot.notices).some(
      (row) => row.kind === "item" && !row.steer && row.node.item.content.case === "userMessage",
    ),
  ).toBe(false);
}

test.skipIf(!dockerAvailable).each([false, true])(
  "attachment input precedes work live and after reload (client id: %s)",
  async (clientId) => {
    const gateway = await startTestGateway();
    const abort = new AbortController();

    try {
      gateway.worker.holdTurns = true;
      const projectId = (await gateway.api.createProject({ name: "Input order" })).project!.id;

      const workspaceId = (
        await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/order" })
      ).workspace!.id;

      const threadId = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!
        .id;

      await eventually(
        () => gateway.api.getThread({ threadId }),
        (reply) => reply.thread?.status === "idle",
      );
      const watching = await followThread(gateway.api.watchThread({ threadId }, { signal: abort.signal }), abort);

      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3366cc" } })
        .png()
        .toBuffer();

      const attachmentIds = [];

      for (const file of [
        { name: "screenshot.png", data: png },
        { name: "landing-copy-final.md", data: new TextEncoder().encode("# Landing copy") },
      ])
        attachmentIds.push((await gateway.api.uploadAttachment(file)).attachment!.id);

      const sent = await gateway.api.sendMessage({
        threadId,
        text: "Review these files",
        attachmentIds,
        clientRequestId: crypto.randomUUID(),
      });

      const turnId = sent.turn!.id;
      await watching.until((snapshot) =>
        snapshot.turns.some((turn) => turn.id === turnId && turn.status === "running"),
      );
      // The canonical message and both attachments reach clients before any provider output.
      expect(watching.state.turns.find((turn) => turn.id === turnId)?.attachments).toHaveLength(2);
      gateway.worker.emit(threadId, turnId, {
        case: "notice",
        value: { code: "connectors_applied", level: NoticeLevel.INFO, message: "Connector tools updated" },
      });
      gateway.worker.emit(threadId, turnId, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "commentary",
            status: ItemStatus.COMPLETED,
            content: { case: "agentMessage", value: { text: "I will review the files.", phase: "commentary" } },
          },
        },
      });
      await watching.until((snapshot) => snapshot.notices.some((notice) => notice.turnId === turnId));
      const builder = new FeedBuilder();
      assertInputFirst(builder, watching.state, turnId);
      const input = gateway.worker.started.get(turnId)!;
      gateway.worker.emit(threadId, turnId, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "input-echo",
            status: ItemStatus.COMPLETED,
            content: { case: "userMessage", value: { text: input.text, clientId: clientId ? turnId : "" } },
          },
        },
      });
      await watching.until((snapshot) => snapshot.items.some((entry) => entry.item?.itemId === "input-echo"));
      const echo = watching.state.items.find((entry) => entry.item?.itemId === "input-echo")!;
      // Audit sequence records actual arrival; it must not replace the persisted turn's input position.
      expect(echo.firstSeq).toBeGreaterThan(watching.state.notices.find((notice) => notice.turnId === turnId)!.seq);
      assertInputFirst(builder, watching.state, turnId);

      const steered = await gateway.api.sendMessage({
        threadId,
        text: "Check the headline too",
        delivery: ui.MessageDelivery.STEER,
        clientRequestId: crypto.randomUUID(),
      });

      const steerId = `user-${steered.steer!.id}`;
      await watching.until((snapshot) => snapshot.items.some((entry) => entry.item?.itemId === steerId));
      const rows = feed(builder, watching.state, true);
      expect(rows.findIndex((row) => row.key === `item:${steerId}`)).toBeGreaterThan(
        rows.findIndex((row) => row.key === "item:commentary"),
      );
      expect(
        turnBody(watching.state.turns[0]!, watching.state.items, watching.state.notices).find(
          (row) => row.key === `item:${steerId}`,
        ),
      ).toMatchObject({ steer: true });
      gateway.worker.finish(threadId, turnId);
      await watching.until((snapshot) =>
        snapshot.turns.some((turn) => turn.id === turnId && turn.status === "completed"),
      );
      assertInputFirst(builder, watching.state, turnId);
      await watching.close();
      const reloadedAbort = new AbortController();

      const reloaded = await followThread(
        gateway.api.watchThread({ threadId, sequence: true }, { signal: reloadedAbort.signal }),
        reloadedAbort,
      );

      try {
        assertInputFirst(new FeedBuilder(), reloaded.state, turnId);
      } finally {
        await reloaded.close();
      }
    } finally {
      abort.abort();
      await gateway.close();
    }
  },
  60000,
);
