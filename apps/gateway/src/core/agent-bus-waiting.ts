import type { JsonValue } from "@bufbuild/protobuf";
import type { AgentBusArgs } from "@canopy/domain";
import { Effect } from "effect";
import { AgentBusStore, Invalid, type CallSource } from "../store/index.ts";
import { busState, WAIT_POLL_MS } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";

export async function busWait(
  host: AgentBus,
  source: CallSource,
  args: AgentBusArgs["wait_threads"],
): Promise<JsonValue> {
  const run = host[busState].host.run.bind(host[busState].host);
  const deadline = new Date(await run(AgentBusStore.use((s) => s.beginWait(source, args)))).getTime();

  for (;;) {
    const result = await run(
      AgentBusStore.use((s) =>
        s.observe(
          source.threadId,
          Effect.gen(function* () {
            const waiting = yield* s.storedCall(source.callId);

            if (waiting?.status !== "requested") return yield* Effect.fail(new Invalid("This request expired."));
            const threads = yield* Effect.forEach(args.thread_ids, (id) => s.summary(id));
            const ready = threads.map((t) => t.settled || t.waiting_for_parent > 0);
            const done = args.until === "all" ? ready.every(Boolean) : ready.some(Boolean);
            const messages = yield* s.messages(source.threadId, args.thread_ids);

            if (!done && messages.length === 0 && Date.now() < deadline) return undefined;

            const result = {
              done,
              threads: threads.map((thread) => ({ ...thread })),
              messages: messages.map((message) => ({ ...message })),
            };

            yield* s.recordCall({ source, tool: "wait_threads", args, ok: true, result });

            return result;
          }),
        ),
      ),
    );

    if (result) return result;
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
