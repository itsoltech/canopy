import { expect } from "bun:test";
import { ui } from "@canopy/contracts";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { eventually } from "./gateway.ts";

export async function followThread(
  source: AsyncIterable<ui.ThreadUpdate>,
  abort: AbortController,
  base?: ui.ThreadSnapshot,
) {
  let state = base;
  let failure: unknown;
  let count = 0;

  const reading = (async () => {
    try {
      for await (const update of source) {
        state = applyThreadUpdate(state, update);
        count++;
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    }
  })();

  await eventually(
    async () => count,
    (value) => value > 0,
  );
  expect(failure).toBeUndefined();

  return {
    get updates() {
      return count;
    },
    get state() {
      return state!;
    },
    async until(predicate: (snapshot: ui.ThreadSnapshot) => boolean) {
      await eventually(async () => state!, predicate);
      expect(failure).toBeUndefined();
      expect(predicate(state!)).toBe(true);
    },
    async close() {
      abort.abort();
      await reading;
    },
  };
}
