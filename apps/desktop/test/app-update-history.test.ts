import { expect, test } from "bun:test";
import { tempDir } from "@canopy/testing";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopAppHistory } from "../src/app-update-history.ts";

test("this app's update history survives process restarts and gateway switches, with one launch notice", () => {
  const directory = tempDir("canopy-app-history-");
  expect(desktopAppHistory(directory, "0.2.0-nightly.133")()).toEqual({
    version: "0.2.0-nightly.133",
    from: "",
    updated: false,
  });
  const updated = desktopAppHistory(directory, "0.2.0-nightly.146");
  expect(updated()).toEqual({ version: "0.2.0-nightly.146", from: "0.2.0-nightly.133", updated: true });
  expect(updated().updated).toBe(false);
  // The selected gateway never enters the store key; another web window reads the same pair.
  expect(desktopAppHistory(directory, "0.2.0-nightly.146")()).toEqual({
    version: "0.2.0-nightly.146",
    from: "0.2.0-nightly.133",
    updated: false,
  });
  expect(desktopAppHistory(directory, "0.2.0-nightly.100")().from).toBe("");
});

test("missing or damaged advisory history establishes a baseline without showing all releases", () => {
  const directory = tempDir("canopy-app-history-damaged-");
  writeFileSync(join(directory, "app-update-history.json"), "{broken");
  expect(desktopAppHistory(directory, "0.2.0")()).toEqual({ version: "0.2.0", from: "", updated: false });
});
