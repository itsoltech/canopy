import { expect, test } from "bun:test";
import { isDesktopRoute } from "@canopy/ui/desktop";
import { AppRoutes } from "../src/app-routes.ts";
import { settingsMenu } from "../src/settings-menu.ts";

test("desktop route IPC accepts Settings paths and rejects external or unrelated navigation", () => {
  for (const path of ["/settings", "/settings/connectors", "/settings/projects/project-id"])
    expect(isDesktopRoute(path)).toBe(true);

  for (const path of [
    undefined,
    null,
    {},
    1,
    "/",
    "/desktop?settings=1",
    "/settings-other",
    "//settings",
    "https://example.com/settings",
    "javascript:alert(1)",
    "/settings/../desktop",
    "/settings/%2e%2e/desktop",
    "/settings\\desktop",
    "/settings?next=/desktop",
    "/settings#other",
    "/settings\n",
  ])
    expect(isDesktopRoute(path)).toBe(false);
});

test("route requests wait for the renderer and survive document loading", () => {
  const routes = new AppRoutes();
  const delivered: string[] = [];
  const target = { send: (_channel: string, path: string) => delivered.push(path) };
  routes.open(target, "/settings");
  routes.open(target, "/settings/connectors");
  expect(delivered).toEqual([]);
  routes.ready(target);

  expect(delivered).toEqual(["/settings/connectors"]);
  routes.loading(target);
  routes.open(target, "/settings/general");
  routes.open(target, "/desktop");
  routes.ready(target);
  routes.ready(target);

  expect(delivered).toEqual(["/settings/connectors", "/settings/general"]);
  routes.open(target, "/settings");
  expect(delivered.at(-1)).toBe("/settings");
});

test("the Settings accelerator opens app settings and changing desktop mode has no accelerator", () => {
  let opened = "";

  const items = settingsMenu(
    () => {
      opened = "settings";
    },
    () => {
      opened = "mode";
    },
  );

  expect(items[0]?.label).toBe("Settings…");
  expect(items[0]?.accelerator).toBe("CmdOrCtrl+,");
  expect(items[1]?.label).toBe("Change desktop mode…");
  expect(items[1]?.accelerator).toBeUndefined();
  items[0]?.click();
  expect(opened).toBe("settings");
  items[1]?.click();
  expect(opened).toBe("mode");
});
