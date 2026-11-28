import { expect, spyOn, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import {
  checkWindowsUpdateInstall,
  launchWindowsUpdate,
  WindowsManualUpdateError,
  WindowsUpdateAdminError,
} from "../src/update-install.ts";

const perUser = "C:\\Users\\Canopy user\\AppData\\Local\\Programs\\Canopy";
const perMachine = "C:\\Program Files\\Canopy";

test("Windows preflight permits the registered per-user app alongside a separate machine installation", () => {
  const registry = () => ({ user: perUser, machine: perMachine });

  expect(() => checkWindowsUpdateInstall(perUser.toLowerCase(), false, registry, () => {})).not.toThrow();
  expect(() => checkWindowsUpdateInstall(perMachine, false, registry, () => {})).toThrow(WindowsUpdateAdminError);
});

test("Windows preflight requires a matching user registration and keeps administrator checks", () => {
  const writable = () => {};

  expect(() => checkWindowsUpdateInstall(perUser, false, () => ({ user: perMachine }), writable)).toThrow(
    WindowsManualUpdateError,
  );
  expect(() => checkWindowsUpdateInstall(perUser, true, () => ({ user: perUser }), writable)).toThrow(
    WindowsUpdateAdminError,
  );
  expect(() =>
    checkWindowsUpdateInstall(
      perUser,
      false,
      () => ({ user: perUser }),
      () => {
        throw new Error("Access denied");
      },
    ),
  ).toThrow(WindowsUpdateAdminError);
});

test("Windows installer launch selects the confirmed user scope and waits for the child to start", async () => {
  const child = new ChildProcess();
  const unref = spyOn(child, "unref");
  const installer = "C:\\Canopy updates\\Canopy Setup.exe";

  const launch = launchWindowsUpdate(installer, (file, args, options) => {
    expect(file).toBe(installer);
    expect(args).toEqual(["--updated", "/S", "--force-run", "/currentuser"]);
    expect(options).toEqual({ detached: true, stdio: "ignore" });

    return child;
  });

  await Promise.resolve();
  expect(unref).not.toHaveBeenCalled();
  child.emit("spawn");
  await launch;
  expect(unref).toHaveBeenCalledTimes(1);
});

test("Windows installer launch reports a rejected process without retrying with elevation", async () => {
  const child = new ChildProcess();
  let attempts = 0;

  const launch = launchWindowsUpdate("Canopy Setup.exe", () => {
    attempts++;

    return child;
  });

  const error = new Error("Spawn denied by Windows");
  child.emit("error", error);
  await expect(launch).rejects.toBe(error);
  expect(attempts).toBe(1);
});
