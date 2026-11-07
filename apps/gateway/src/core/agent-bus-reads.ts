import type { JsonValue } from "@bufbuild/protobuf";
import type { AgentBusCall } from "@canopy/domain";
import { Effect } from "effect";
import { AgentBusStore, type CallSource } from "../store/index.ts";
import { busState } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";

export const busRead = (
  host: AgentBus,
  source: CallSource,
  call: Extract<AgentBusCall, { tool: "get_thread" | "read_thread" }>,
): Promise<JsonValue> =>
  host[busState].host.run(
    AgentBusStore.use((s) =>
      s.observe(
        source.threadId,
        Effect.gen(function* () {
          if (call.tool === "get_thread") {
            const summary = yield* s.summary(call.args.thread_id);
            const messages = yield* s.messages(source.threadId, [call.args.thread_id]);
            const result = { ...summary, messages: messages.map((message) => ({ ...message })) };
            yield* s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result });

            return result;
          }

          const { result, observedTurnIds } = yield* s.readThread({
            recipient: source.threadId,
            threadId: call.args.thread_id,
            afterSeq: call.args.after_seq ?? 0,
            limit: call.args.limit ?? 50,
            view: call.args.view ?? "messages",
          });

          yield* s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result, observedTurnIds });

          return result;
        }),
      ),
    ),
  );
