import { describe, expect, test } from "bun:test";
import { isSettingsRoute, overlayKey, pageModule } from "./settings-route.ts";

describe("settings overlay routes", () => {
  test("routes under /settings", () => {
    expect(isSettingsRoute("/settings")).toBe(true);
    expect(isSettingsRoute("/settings/workers/[workerId]")).toBe(true);
    expect(isSettingsRoute("/settingsx")).toBe(false);
    expect(isSettingsRoute("/threads/[threadId]")).toBe(false);
    expect(isSettingsRoute(null)).toBe(false);
    expect(isSettingsRoute(undefined)).toBe(false);
  });

  test("a page is its path and query, without origin or hash", () => {
    expect(overlayKey("http://example.test/settings/workers/w1/models?profile=p&provider=claude#top")).toBe("/settings/workers/w1/models?profile=p&provider=claude");
    expect(overlayKey("/settings/appearance")).toBe("/settings/appearance");
    expect(overlayKey(new URL("http://example.test/settings/threads"))).toBe("/settings/threads");
  });

  test("the page module of a route id", () => {
    expect(pageModule("/settings/projects/[projectId]")).toBe("/src/routes/settings/projects/[projectId]/+page.svelte");
  });
});
