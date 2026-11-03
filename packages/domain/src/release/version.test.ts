import { expect, test } from "bun:test";
import { releaseChannel } from "./version.ts";

test("build identity follows the running version, including local development builds", () => {
  expect(releaseChannel("0.1.0")).toBe("stable");
  expect(releaseChannel("0.2.0-beta.1")).toBe("beta");
  expect(releaseChannel("0.2.0-nightly.12")).toBe("nightly");
  expect(releaseChannel("0.0.0-dev")).toBe("development");
  expect(releaseChannel("0.1.0-dev.abc1234")).toBe("development");
});
