import { goto } from "$app/navigation";
import { ui } from "@canopy/contracts";
import { tick } from "svelte";
import { decode } from "#lib/shared/wire.ts";
import { ThreadState } from "../thread-state.svelte.ts";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Run from the dev console against the disposable seeded stack, without modifying the app's subscriptions. */
export async function probeThreadSnapshot(threadId: string, repeats = 20) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("Use 1–100 snapshots");
  const samples: { arrivalMs: number; handlerMs: number; bytes: number; turns: number; items: number }[] = [];

  for (let index = 0; index < repeats; index++) {
    const state = new ThreadState();
    const start = performance.now();
    const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?incremental=1`);

    try {
      samples.push(
        await new Promise<(typeof samples)[number]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Thread snapshot timed out")), 20_000);

          source.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Thread snapshot connection failed"));
          };

          source.onmessage = (message) => {
            const arrived = performance.now();

            try {
              const update = decode(ui.ThreadUpdateSchema, JSON.parse(message.data));

              if (update.change.case !== "snapshot") return;
              state.apply(update);
              const handlerMs = performance.now() - arrived;
              clearTimeout(timer);
              resolve({
                arrivalMs: arrived - start,
                handlerMs,
                bytes: new TextEncoder().encode(message.data).byteLength,
                turns: state.turns.length,
                items: state.entries.length,
              });
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          };
        }),
      );
    } finally {
      source.close();
    }
  }

  return samples;
}

/** SPA navigation to the first painted thread articles and a focusable composer; this is not browser TTI. */
export async function probeThreadNavigation(path: string) {
  const started = performance.now();
  await goto(path);
  const deadline = performance.now() + 20_000;

  while (!document.querySelector('[role="feed"] article')) {
    if (performance.now() > deadline) throw new Error("Thread articles did not mount");
    await frame();
  }

  await tick();
  await frame();
  await frame();
  const paintMs = performance.now() - started;
  const composer = document.querySelector<HTMLElement>('[contenteditable="true"]');
  composer?.focus();

  return {
    paintMs,
    focusReadyMs: composer && document.activeElement === composer ? performance.now() - started : undefined,
    nodes: document.querySelectorAll("*").length,
  };
}
