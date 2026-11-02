import { expect, test } from "bun:test";
import { ComposerCompaction } from "../../../features/threads/components/composer-compaction.ts";
import { ScrollIntent } from "./scroll.ts";

test("programmatic and smooth scrolls cannot compact or expand, even during a gesture lease", () => {
  const intent = new ScrollIntent();
  const state = new ComposerCompaction();
  const scroll = (top: number, distance: number, up: number, now: number, smoothUntil = 0) => {
    if (intent.origin(top, smoothUntil, now) === "reader") state.scroll({ distance, up });
  };
  intent.gesture(100);
  intent.programmatic(800);
  scroll(800, 300, 200, 110);
  expect(state.compact).toBe(false);
  scroll(600, 500, 200, 120);
  expect(state.compact).toBe(true);
  intent.programmatic(1100);
  scroll(1100, 0, -500, 130);
  expect(state.compact).toBe(true);
  scroll(1200, 0, -100, 140, 500);
  expect(state.compact).toBe(true);
});

test("inertia renews the lease; editing clears it; unattributed layout scrolls are ignored", () => {
  const intent = new ScrollIntent();
  expect(intent.origin(500, 0, 100)).toBe("unattributed");
  intent.gesture(100);
  expect(intent.origin(400, 0, 340)).toBe("reader");
  expect(intent.origin(300, 0, 580)).toBe("reader");
  expect(intent.origin(200, 0, 831)).toBe("unattributed");
  intent.gesture(900);
  intent.reset();
  expect(intent.origin(1000, 0, 910)).toBe("unattributed");
});
