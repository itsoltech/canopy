import { describe, expect, test } from "bun:test";
import { DeviceViewPreferences } from "@canopy/domain/device-view";
import {
  rememberThreadScroll,
  restoreThreadAnchor,
  threadAnchorOffset,
  THREAD_SCROLL_LIMIT,
  type SavedThreadScroll,
} from "@canopy/domain/thread-scroll";
import { followingAfterScroll, ScrollIntent } from "../../apps/web/src/lib/shared/ui/virtual/scroll.ts";

describe("client-local thread reading positions", () => {
  test("history anchors survive reload and new messages without crossing devices or account migration", () => {
    let raw = "";

    const device = new DeviceViewPreferences(
      () => {},
      (value) => {
        raw = value;
      },
    );

    device.load(null);
    device.initialize({});
    device.set({
      threadScroll: rememberThreadScroll(device.values.threadScroll, "a", {
        mode: "anchor",
        key: "item:answer",
        offset: 123,
      }),
    });
    device.set({ threadScroll: rememberThreadScroll(device.values.threadScroll, "b", { mode: "following" }) });

    const reloaded = new DeviceViewPreferences(
      () => {},
      () => {},
    );

    reloaded.load(raw);
    reloaded.initialize({});
    expect(reloaded.values.threadScroll).toEqual(device.values.threadScroll);
    expect(
      restoreThreadAnchor(reloaded.values.threadScroll[0]?.position, ["older", "item:answer", "new message"]),
    ).toEqual({ index: 1, key: "item:answer", offset: 123 });
    expect(restoreThreadAnchor(reloaded.values.threadScroll[1]?.position, ["new message"])).toBeUndefined();

    const otherDevice = new DeviceViewPreferences(
      () => {},
      () => {},
    );

    otherDevice.load(null);
    expect(otherDevice.values.threadScroll).toEqual([]);
  });

  test("bounded LRU keeps the most recently visited threads, including following threads", () => {
    let saved: SavedThreadScroll[] = [];

    for (let i = 0; i < THREAD_SCROLL_LIMIT; i++) saved = rememberThreadScroll(saved, String(i), { mode: "following" });
    saved = rememberThreadScroll(saved, "0", { mode: "anchor", key: "answer", offset: 4 });
    saved = rememberThreadScroll(saved, "new", { mode: "following" });
    expect(saved).toHaveLength(THREAD_SCROLL_LIMIT);
    expect(saved.some((entry) => entry.threadId === "1")).toBe(false);
    expect(saved.at(-2)?.threadId).toBe("0");

    const device = new DeviceViewPreferences(
      () => {},
      () => {},
    );

    device.load(JSON.stringify({ threadScroll: [...saved, { threadId: "extra", position: { mode: "following" } }] }));
    expect(device.values.threadScroll).toHaveLength(THREAD_SCROLL_LIMIT);
    expect(device.values.threadScroll.at(-1)?.threadId).toBe("extra");
  });

  test("missing, out-of-window and invalid anchors fall back; native parents locate variable-height turns", () => {
    const anchor = { mode: "anchor", key: "message", parent: "turn", offset: 320 } as const;
    expect(restoreThreadAnchor(anchor, ["newer", "turn", "older"])).toEqual({ index: 1, key: "message", offset: 320 });
    expect(restoreThreadAnchor(anchor, ["newer"])).toBeUndefined();
    expect(restoreThreadAnchor(undefined, ["turn"])).toBeUndefined();
    expect(restoreThreadAnchor({ ...anchor, offset: Number.NaN }, ["turn"])).toBeUndefined();
    expect(threadAnchorOffset(320, 100)).toBe(99);
    expect(threadAnchorOffset(-4, 100)).toBe(0);
    expect(threadAnchorOffset(40, 100)).toBe(40);
    // The first message rests below the top padding: keep that distance, within half a viewport.
    expect(threadAnchorOffset(-72, 100, 400)).toBe(-72);
    expect(threadAnchorOffset(-900, 100, 400)).toBe(-400);
    const intent = new ScrollIntent();
    intent.programmatic(1000);
    expect(intent.origin(1000, 0, 1)).toBe("programmatic");
    expect(intent.origin(746, 0, 2)).toBe("unattributed");
    intent.gesture(3);
    expect(intent.origin(600, 0, 4)).toBe("reader");
    expect(followingAfterScroll(true, "unattributed", 1254, 1254, false)).toBe(true);
    expect(followingAfterScroll(true, "programmatic", 500, 400, false)).toBe(true);
    expect(followingAfterScroll(true, "reader", 500, 400, false)).toBe(false);
    expect(followingAfterScroll(false, "reader", 0, -400, false)).toBe(true);
  });
});
