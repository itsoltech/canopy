import { clone, create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { nodeRef, qualifyId, REMOTE_BOTS, splitId, THREAD_MIRROR } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { Match } from "effect";
import { globalize, linkedMessage, mapIds, methodNamed, movedItems, qualify, unqualify } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { globalIds, redirected, single, target } from "./routed-context.ts";
import { toConnectError } from "./ui-errors.ts";
import { ConfigIds } from "./routed-config.ts";

export async function peerOf(core: GatewayCore, ref: string, method?: DescMethod, request?: Message) {
  if (!core.computers) throw new ConnectError("That computer is no longer linked", Code.NotFound);

  try {
    return (await core.computers.resolve(ref)).node_id;
  } catch (error) {
    // A thing that moved to a computer this one is not linked with: say where it went.
    let moved: string | undefined;

    if (method && request)
      mapIds(method.input, request, (value) => {
        const { id, node } = splitId(value);
        const row = node === ref ? core.computers?.redirects.home(id) : undefined;
        moved ??= row && (row.home_name || "another computer");

        return value;
      });
    throw moved
      ? new ConnectError(`Moved to ${moved}, which isn't linked to this computer`, Code.FailedPrecondition)
      : error;
  }
}

/** One call to a thread's home. Shared projects keep their one id in both directions. A thing that moved is followed once. */
export async function* forward(
  core: GatewayCore,
  nodeId: string,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
  followed = false,
): AsyncGenerator<Message> {
  const global = globalIds(core);

  try {
    for await (const message of home(core, nodeId, method, request, signal, global)) {
      globalize(method.output, message, global);
      const self = core.computers && nodeRef(core.computers.hello().nodeId);

      if (self) mapIds(method.output, message, (id) => (splitId(id).node === self ? splitId(id).id : id));
      yield message;
    }
  } catch (error) {
    const moved = movedItems(error);

    if (!moved || followed || !core.computers) throw error;
    await core.computers.redirects.learn(nodeId, moved);
    const next = redirected(core, method, request);
    const node = next !== request ? target(method, next) : undefined;

    // Moved here (it came back) or nowhere this computer knows: the caller sees where it went.
    if (!node) throw error;
    yield* forward(core, await peerOf(core, node, method, next), method, next, signal, true);
  }
}

/** Ids become the home's, attachments uploaded here travel with the message; offline, the mirror answers reads. */
export async function* home(
  core: GatewayCore,
  nodeId: string,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
  global: ReadonlySet<string>,
): AsyncGenerator<Message> {
  const computers = core.computers;

  if (!computers) throw new ConnectError("That computer is no longer linked", Code.NotFound);

  if (!computers.reachable().includes(nodeId) && computers.capabilities(nodeId).includes(REMOTE_BOTS)) {
    if (method.name === "ListBots" || method.name === "GetBot" || method.name === "WatchBotConversation") {
      const snapshots = await computers.botMirror.conversations(nodeId);

      if (method.name === "ListBots") {
        yield create(bots.ListBotsResponseSchema, {
          bots: snapshots.flatMap((c) =>
            c.bot && (linkedMessage(bots.ListBotsRequestSchema, request).includeArchived || !c.bot.archived)
              ? [c.bot]
              : [],
          ),
        });
      } else {
        const id =
          method.name === "GetBot"
            ? linkedMessage(bots.GetBotRequestSchema, request).botId
            : linkedMessage(ui.GatewayService.method.watchBotConversation.input, request).botId;

        const snapshot = snapshots.find((s) => s.bot?.id === id);

        if (!snapshot)
          throw new ConnectError(
            "This bot has not been synced yet. Connect its computer to read it.",
            Code.Unavailable,
          );

        if (method.name === "GetBot") yield create(bots.GetBotResponseSchema, { bot: snapshot.bot });
        else {
          const changes = new AsyncChannel<void>();

          const unsubscribe = computers.subscribe((c) => {
            if (c.nodeId === nodeId) changes.close();
          });

          const abort = () => changes.close();
          signal.addEventListener("abort", abort, { once: true });

          try {
            yield snapshot;

            if (!signal.aborted && !computers.reachable().includes(nodeId))
              for await (const _ of changes) {
                /* wait for reconnect */
              }
          } finally {
            unsubscribe();
            signal.removeEventListener("abort", abort);
          }
        }
      }

      return;
    }
  }

  if (!computers.reachable().includes(nodeId) && computers.capabilities(nodeId).includes(THREAD_MIRROR)) {
    if (method.name === "GetThread" || method.name === "WatchThread") {
      const threadId = splitId(
        method.name === "GetThread"
          ? linkedMessage(ui.GetThreadRequestSchema, request).threadId
          : linkedMessage(ui.WatchThreadRequestSchema, request).threadId,
      ).id;

      const snapshot = await computers.mirror.snapshot(nodeId, threadId);

      if (!snapshot?.thread)
        throw new ConnectError(
          "This thread has not been synced yet. Connect its computer to read it.",
          Code.Unavailable,
        );

      if (method.name === "GetThread") yield create(ui.GetThreadResponseSchema, { thread: snapshot.thread });
      else {
        // End on any peer/mirror change. The normal UI reconnect opens the live home stream again.
        const changes = new AsyncChannel<void>();

        const unsubscribe = computers.subscribe((c) => {
          if (c.nodeId === nodeId) changes.close();
        });

        const abort = () => changes.close();
        signal.addEventListener("abort", abort, { once: true });

        try {
          yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });

          if (!signal.aborted && !computers.reachable().includes(nodeId))
            for await (const _ of changes) {
              /* closed by a change */
            }
        } finally {
          unsubscribe();
          signal.removeEventListener("abort", abort);
        }
      }

      return;
    }

    if (method.name === "ListThreads") {
      yield create(ui.ListThreadsResponseSchema, {
        threads: await computers.mirror.threads(
          nodeId,
          create(ui.ListThreadsRequestSchema, {
            ...linkedMessage(ui.ListThreadsRequestSchema, request),
            projectId: splitId(linkedMessage(ui.ListThreadsRequestSchema, request).projectId).id,
          }),
        ),
      });

      return;
    }

    if (method.name === "GetOverview") {
      yield await computers.mirror.overview(nodeId);

      return;
    }

    if (method.name === "GetAttachment" || method.name === "GetThreadBlob") {
      const peer = await computers.computer(nodeId);
      throw new ConnectError(
        `Available when ${peer?.displayName || peer?.name || "the other computer"} is connected`,
        Code.Unavailable,
      );
    }
  }

  yield* send(core, computers, nodeId, method, request, signal, global);
}

/** The call itself: this computer's ids become the home's, and the answer's ids this computer's. */
async function* send(
  core: GatewayCore,
  computers: NonNullable<GatewayCore["computers"]>,
  nodeId: string,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
  global: ReadonlySet<string>,
): AsyncGenerator<Message> {
  const outbound = clone(method.input, request);
  await carryAttachments(core, nodeId, method, outbound, signal);
  unqualify(method.input, outbound, nodeId, global);
  const ids = await ConfigIds.for(core, nodeId);
  await ids.map(method.input, outbound, "toGlobal");

  for await (const message of computers.remote(nodeId, method, outbound, signal)) {
    await ids.map(method.output, message, "toLocal");
    qualify(method.output, message, nodeId);
    yield message;
  }
}

/** The browser uploads to this gateway; a message for another computer's thread brings its files along. */
export async function carryAttachments(
  core: GatewayCore,
  nodeId: string,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
) {
  const field = Match.value(method.name).pipe(
    Match.when("SendMessage", () => "attachmentIds" as const),
    Match.when("CreateThread", () => "initialAttachmentIds" as const),
    Match.orElse(() => undefined),
  );

  if (!field) return;
  // SAFETY: The method-name match above selects the corresponding repeated string field in this decoded request.
  const record = request as Message & { attachmentIds: string[]; initialAttachmentIds: string[] };
  const upload = methodNamed("UploadAttachment")!;
  record[field] = await Promise.all(
    record[field]!.map(async (id) => {
      if (splitId(id).node) return id;
      let file: ui.GetAttachmentResponse;

      try {
        file = await core.getAttachment(id, false);
      } catch (error) {
        throw toConnectError(error);
      }

      const sent = await single<ui.UploadAttachmentResponse>(
        core.computers!.remote(
          nodeId,
          upload,
          create(ui.UploadAttachmentRequestSchema, { name: file.attachment?.name ?? "file", data: file.data }),
          signal,
        ),
      );

      return qualifyId(sent.attachment?.id ?? "", nodeId);
    }),
  );
}
