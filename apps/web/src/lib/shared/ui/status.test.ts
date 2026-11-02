import { describe, expect, test } from "bun:test";
import { statusLook } from "./status.ts";

describe("statusLook", () => {
  test("known statuses", () => {
    expect(statusLook("waiting_input")).toMatchObject({ label: "Needs input", tone: "amber", active: true });
  });

  test("an unknown status is said in words, never as its key", () => {
    expect(statusLook("waiting_for_review").label).toBe("Waiting for review");
    expect(statusLook("THREAD_STATUS_PAUSED").label).toBe("Paused");
    expect(statusLook("").label).toBe("Unknown");
  });
});
