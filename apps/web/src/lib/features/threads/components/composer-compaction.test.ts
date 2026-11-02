import { describe, expect, test } from "bun:test";
import { COMPACT_DISTANCE, COMPACT_TRAVEL, ComposerCompaction } from "./composer-compaction.ts";
import { FEED_END_THRESHOLD } from "../../../shared/ui/virtual/scroll.ts";

describe("composer compaction", () => {
  test("requires both distance from latest and deliberate upward travel", () => {
    const state = new ComposerCompaction();
    state.scroll({ distance: COMPACT_DISTANCE - 1, up: COMPACT_TRAVEL });
    expect(state.compact).toBe(false);
    state.scroll({ distance: COMPACT_DISTANCE, up: 1 });
    expect(state.compact).toBe(true);
    state.scroll({ distance: 20, up: -100 });
    expect(state.compact).toBe(true);
    state.scroll({ distance: FEED_END_THRESHOLD, up: -12 });
    expect(state.compact).toBe(false);
  });

  test("small reversing scrolls do not accumulate into compaction", () => {
    const state = new ComposerCompaction();
    for (let i = 0; i < 10; i++) {
      state.scroll({ distance: 300, up: 30 });
      state.scroll({ distance: 270, up: -30 });
    }
    expect(state.compact).toBe(false);
  });

  test("focus expands and protects the editor until blur and a fresh scroll", () => {
    const state = new ComposerCompaction();
    state.scroll({ distance: 500, up: 500 });
    state.focus(true);
    state.scroll({ distance: 900, up: 400 });
    expect(state.compact).toBe(false);
    state.focus(false);
    state.scroll({ distance: 910, up: 10 });
    expect(state.compact).toBe(false);
    state.scroll({ distance: 1010, up: 100 });
    expect(state.compact).toBe(true);
  });

  for (const kind of ["typing", "drop", "paste", "menu"] as const) {
    test(`${kind} expands; passive streaming/layout updates cannot change state`, () => {
      const state = new ComposerCompaction();
      state.scroll({ distance: 500, up: 500 });
      expect(state.compact).toBe(true);
      state.interact(kind);
      expect(state.compact).toBe(false);
      state.scroll({ distance: 600, up: 0 });
      expect(state.compact).toBe(false);
    });
  }

  test("pending synchronous question expands and prevents compaction", () => {
    const state = new ComposerCompaction();
    state.scroll({ distance: 500, up: 500 });
    state.question(true);
    state.scroll({ distance: 1000, up: 500 });
    expect(state.compact).toBe(false);
    state.question(false);
    state.scroll({ distance: 1100, up: 100 });
    expect(state.compact).toBe(true);
  });
});
