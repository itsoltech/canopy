import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { ThreadState } from "../thread-state.svelte.ts";

/** Writes one synthetic turn: use only the thread printed by client-stack on its disposable database. */
export async function probeThreadStream(threadId: string) {
  const state = new ThreadState();
  const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?incremental=1`);
  const samples: number[] = [];
  let sent = false;
  let turnId = "";
  const started = performance.now();
  let cancelTimeout = () => {};

  try {
    return await new Promise<{ durationMs: number; messages: number; handlerP50Ms: number; handlerP95Ms: number }>(
      (resolve, reject) => {
        const finish = () => {
          const turn = state.turns.find((candidate) => candidate.id === turnId);

          if (!turn || turn.status === "queued" || turn.status === "running") return;

          if (turn.status !== "completed" || !samples.length) {
            reject(new Error(`Synthetic turn ended as ${turn.status} with ${samples.length} deltas`));

            return;
          }

          samples.sort((a, b) => a - b);
          resolve({
            durationMs: performance.now() - started,
            messages: samples.length,
            handlerP50Ms: samples[Math.floor(samples.length * 0.5)] ?? 0,
            handlerP95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
          });
        };

        const timer = setTimeout(() => reject(new Error("Synthetic stream timed out")), 30_000);
        cancelTimeout = () => clearTimeout(timer);
        source.onerror = () => reject(new Error("Synthetic stream disconnected"));
        source.onmessage = (message) => {
          const before = performance.now();

          try {
            const update = decode(ui.ThreadUpdateSchema, JSON.parse(message.data));
            state.apply(update);
            const elapsed = performance.now() - before;

            if (update.change.case === "event" && update.change.value.event?.body.case === "itemDelta")
              samples.push(elapsed);

            if (!sent && update.change.case === "snapshot") {
              sent = true;
              void requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, {
                text: "Stream the synthetic benchmark answer.",
                clientRequestId: crypto.randomUUID(),
              })
                .then((response) => {
                  turnId = decode(ui.SendMessageResponseSchema, response).turn?.id ?? "";

                  if (!turnId) throw new Error("Synthetic message did not return a turn");
                  finish();
                })
                .catch(reject);
            }

            finish();
          } catch (error) {
            reject(error);
          }
        };
      },
    );
  } finally {
    cancelTimeout();
    source.close();
  }
}
