import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import type { ActivityNotchPlacement } from "@canopy/ui/desktop";
import { activityNotchPlacementFile, decodeActivityNotchPlacement } from "../src/activity-notch-placement.ts";

const tempDirectory = tempDirs();

test("a renderer cannot hand main a placement with other fields or an off-screen offset", () => {
  expect(decodeActivityNotchPlacement({ mode: "edge", edge: "left", offset: 0.4, display: 3 })).toEqual({
    mode: "edge",
    edge: "left",
    offset: 0.4,
    display: 3,
  });
  expect(() => decodeActivityNotchPlacement({ mode: "edge", edge: "left", offset: 1.5 })).toThrow();
  expect(() => decodeActivityNotchPlacement({ mode: "floating", x: 0.2, y: 0.2, path: "/tmp" })).toThrow();
  expect(() => decodeActivityNotchPlacement({ mode: "edge", edge: "center", offset: 0.5 })).toThrow();
});

test("an unreadable placement file falls back to the platform default and a saved one survives a restart", async () => {
  const directory = tempDirectory("canopy-notch-placement-");
  await writeFile(join(directory, "activity-notch.json"), '{"mode":"floating","x":2}');

  const fallback: ActivityNotchPlacement =
    process.platform === "darwin" ? { mode: "notch" } : { mode: "edge", edge: "right", offset: 0.25 };

  expect(activityNotchPlacementFile(directory).read()).toEqual(fallback);

  activityNotchPlacementFile(directory).write({ mode: "floating", x: 0.3, y: 0.7, display: 2 });
  expect(activityNotchPlacementFile(directory).read()).toEqual({ mode: "floating", x: 0.3, y: 0.7, display: 2 });
});
