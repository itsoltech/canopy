import { expect, test } from "bun:test";
import { checkWindowsUpdateInstall, WINDOWS_UPDATE_ADMIN_MESSAGE } from "../src/update-install.ts";
import { tempDir } from "@canopy/testing";

test("Windows installation preflight rejects installer metadata, machine scope and unwritable custom directories", () => {
  const directory = tempDir("canopy-update-permissions-");
  const perUser = () => ({ status: 1 });
  expect(() => checkWindowsUpdateInstall(directory, true, perUser)).toThrow(WINDOWS_UPDATE_ADMIN_MESSAGE);
  expect(() => checkWindowsUpdateInstall(directory, false, () => ({ status: 0 }))).toThrow(
    WINDOWS_UPDATE_ADMIN_MESSAGE,
  );
  expect(() =>
    checkWindowsUpdateInstall(directory, false, perUser, () => {
      throw new Error("Access denied");
    }),
  ).toThrow(WINDOWS_UPDATE_ADMIN_MESSAGE);
  expect(() => checkWindowsUpdateInstall(directory, false, perUser)).not.toThrow();
});

test("Windows installation preflight refuses to launch an installer if the registry probe cannot run", () => {
  const directory = tempDir("canopy-update-permissions-");

  for (const result of [{ status: null, error: new Error("Could not start reg.exe") }, { status: null }])
    expect(() => checkWindowsUpdateInstall(directory, false, () => result)).toThrow(
      "Could not check installation permissions. Retry the update on this computer.",
    );
});
