import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  ItemDeltaField,
  ItemStatus,
  Provider,
  ProviderProfileKind,
  ThreadEventSchema,
  TurnOrigin,
  TurnOutcome,
  WorkerState,
  type StartTurn,
} from "@canopy/contracts";
import { openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { workspaceFiles } from "./workspace-files.ts";

/** No CLI or inference: a deterministic answer on the real worker → gateway → BFF → SSE path. */
async function answer(
  start: StartTurn,
  emit: (thread: string, turn: string, body: NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>) => void,
  signal: AbortSignal,
) {
  const thread = start.thread?.threadId;

  if (!thread) return;
  const itemId = `benchmark-${start.turnId}`;
  emit(thread, start.turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
  emit(thread, start.turnId, {
    case: "itemStarted",
    value: {
      item: {
        itemId,
        status: ItemStatus.IN_PROGRESS,
        content: { case: "agentMessage", value: { text: "", phase: "final_answer" } },
      },
    },
  });
  let text = "";

  for (let index = 0; index < 200 && !signal.aborted; index++) {
    const chunk = index % 12 === 11 ? "\n\n" : "Synthetic streaming answer. ";
    text += chunk;
    emit(thread, start.turnId, { case: "itemDelta", value: { itemId, field: ItemDeltaField.TEXT, chunk } });
    await Bun.sleep(40);
  }

  if (signal.aborted) return;
  emit(thread, start.turnId, {
    case: "itemCompleted",
    value: {
      item: {
        itemId,
        status: ItemStatus.COMPLETED,
        content: { case: "agentMessage", value: { text, phase: "final_answer" } },
      },
    },
  });
  emit(thread, start.turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
}

export async function clientWorker(baseUrl: string, worker: { workerId: string; credential: string }) {
  const files = process.env["CANOPY_BENCH_WORKSPACE"] === "1" ? workspaceFiles() : undefined;
  const abort = new AbortController();
  const deadline = Date.now() + 20_000;
  let link: GatewayLink;

  for (;;) {
    try {
      link = await openGatewayLink({
        baseUrl,
        credential: worker.credential,
        hello: {
          workerId: worker.workerId,
          journalId: Bun.randomUUIDv7(),
          state: WorkerState.ACTIVE,
          capabilities: files ? ["thread_files_v1", "thread_file_preview_v1", "thread_directory_v1"] : [],
          attachmentsRoot: "/srv/canopy-attachments",
          providers: [{ provider: Provider.CODEX, available: true, version: "benchmark" }],
        },
        signal: abort.signal,
      });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }

  const sequences = new Map<string, bigint>();

  const emit = (
    threadId: string,
    turnId: string,
    body: NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>,
  ) => {
    const seq = (sequences.get(threadId) ?? 0n) + 1n;
    sequences.set(threadId, seq);
    link.send({
      case: "threadEvent",
      value: create(ThreadEventSchema, {
        threadId,
        turnId,
        body,
        journalSeq: seq,
        eventId: Bun.randomUUIDv7(),
        occurredAt: timestampNow(),
        rawJson: "{}",
      }),
    });
  };

  const loop = (async () => {
    for await (const { payload } of link.messages) {
      if (payload.case === "config") {
        link.send({
          case: "configApplied",
          value: {
            version: payload.value.version,
            applied: true,
            providers: [{ provider: Provider.CODEX, available: true, version: "benchmark" }],
            profiles: [
              { id: "native", kind: ProviderProfileKind.NATIVE, providers: [Provider.CODEX], available: true },
            ],
          },
        });
        link.send({
          case: "modelCatalog",
          value: {
            configVersion: payload.value.version,
            profiles: [
              {
                provider: Provider.CODEX,
                profileId: "native",
                models: [{ id: "benchmark", displayName: "Benchmark", isDefault: true }],
              },
            ],
          },
        });
      }

      if (payload.case !== "command") continue;
      const { commandId, kind } = payload.value;
      const fileResult = await files?.(payload.value);

      if (fileResult) {
        link.send({ case: "commandResult", value: fileResult });
        continue;
      }

      if (kind.case === "startTurn") {
        link.send({ case: "commandResult", value: { commandId, ok: true } });
        await answer(kind.value, emit, abort.signal);
      } else
        link.send({
          case: "commandResult",
          value: {
            commandId,
            ok: false,
            errorCode: "BENCHMARK_ONLY",
            errorMessage: "The synthetic worker only streams benchmark answers.",
          },
        });
    }
  })();

  // Observe failures immediately while leaving the owning stack responsible for cleanup.
  void loop.catch(() => {
    if (!abort.signal.aborted) console.error("Synthetic worker disconnected");
  });

  return async () => {
    abort.abort();
    link.close();
    await loop.catch(() => {});
    await link.closed;
  };
}
