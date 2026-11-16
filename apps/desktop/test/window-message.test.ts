import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import { sendWebContentsMessage } from "../src/window-message.ts";

describe("window IPC delivery", () => {
  test("ignores a WebContents destroyed during delivery", () => {
    let delivered = 0;
    // SAFETY: the helper only needs the WebContents liveness method for this lifecycle test.
    const target = { isDestroyed: () => false } as WebContents;

    sendWebContentsMessage(target, () => {
      delivered++;
      throw new Error("Object has been destroyed");
    });

    expect(delivered).toBe(1);
  });

  test("does not hide unrelated IPC errors", () => {
    // SAFETY: the helper only needs the WebContents liveness method for this lifecycle test.
    const target = { isDestroyed: () => false } as WebContents;

    expect(() =>
      sendWebContentsMessage(target, () => {
        throw new Error("send failed");
      }),
    ).toThrow("send failed");
  });
});
