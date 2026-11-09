import { describe, expect, test } from "bun:test";
import { DeviceViewPreferences } from "@canopy/domain/device-view";
import { materializeSettings, settingsValues } from "../../apps/gateway/src/config-sync/settings.ts";
import { emptyRecord } from "../../apps/gateway/src/config-sync/persistence.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";

function deviceStorage() {
  let raw: string | null = null;

  return {
    open() {
      const preferences = new DeviceViewPreferences(
        () => {},
        (saved) => (raw = saved),
      );

      preferences.load(raw);

      return preferences;
    },
  };
}

describe("device view persistence for clients of the same owner", () => {
  test("disclosure and geometry changes stay on device A and survive reopening without reseeding", () => {
    const legacy = { archivedThreadsExpanded: true, sidebarWidth: 320, sidebarCollapsed: true };
    const aStorage = deviceStorage();
    const bStorage = deviceStorage();
    const a = aStorage.open();
    const b = bStorage.open();
    a.initialize(legacy);
    b.initialize(legacy);
    a.set({ archivedThreadsExpanded: false, archivedBotsExpanded: true, sidebarCollapsed: false, sidebarWidth: 0 });
    a.initialize(legacy);
    expect(a.values).toMatchObject({ archivedThreadsExpanded: false, archivedBotsExpanded: true, sidebarWidth: 0 });
    expect(b.values).toMatchObject({
      archivedThreadsExpanded: true,
      archivedBotsExpanded: false,
      sidebarCollapsed: true,
      sidebarWidth: 320,
    });
    const reopened = aStorage.open();
    reopened.initialize(legacy);
    expect(reopened.values).toEqual(a.values);
    reopened.set({ archivedThreadsExpanded: true, threadPanelCollapsed: true });
    expect(b.values.threadPanelCollapsed).toBe(false);
    expect(legacy).toEqual({ archivedThreadsExpanded: true, sidebarWidth: 320, sidebarCollapsed: true });
    b.set({ archivedThreadsExpanded: false });
    expect(reopened.values.archivedThreadsExpanded).toBe(true);
  });

  test("malformed storage recovers, partial records seed missing fields, widths stay bounded", () => {
    const preferences = deviceStorage().open();
    preferences.load('{"archivedThreadsExpanded":false,"sidebarWidth":9000}');
    preferences.initialize({ archivedThreadsExpanded: true, sidebarCollapsed: true });
    expect(preferences.values).toMatchObject({
      archivedThreadsExpanded: false,
      sidebarCollapsed: true,
      sidebarWidth: 560,
    });
    preferences.load("not json");
    expect(preferences.values.archivedThreadsExpanded).toBe(false);
    preferences.set({ sidebarWidth: 40 });
    expect(preferences.values.sidebarWidth).toBe(220);
  });

  test("linked settings exclude disclosures and ignore fields retained by older peers", () => {
    const stored = {
      appearance: { sidebarWidth: 320, sidebarCollapsed: true, threadPanelCollapsed: true },
      sidebar: { archivedExpanded: true, projectIds: ["project"], workingSection: true },
    };

    const fields = settingsValues(stored, "computer-a");
    expect(fields["sidebar.archivedExpanded"]).toBeUndefined();
    expect(fields["appearance.sidebarWidth"]).toBeUndefined();
    expect(fields["appearance.sidebarCollapsed"]).toBeUndefined();
    expect(fields["appearance.threadPanelCollapsed"]).toBeUndefined();
    expect(fields["sidebar.projectIds"]).toEqual(["project"]);
    expect(fields["sidebar.workingSection"]).toBe(true);
    expect(
      materializeSettings(stored, { "sidebar.archivedExpanded": false, "appearance.sidebarCollapsed": false }, "a"),
    ).toEqual(stored);
    const row = emptyRecord("settings", "account");
    row.fields = {
      "sidebar.archivedExpanded": { value: true, hlc: "1.0.a", prev: "" },
      "appearance.sidebarWidth": { value: 320, hlc: "1.0.a", prev: "" },
      "sidebar.projectIds": { value: ["project"], hlc: "1.0.a", prev: "" },
      "future.preference": { value: true, hlc: "1.0.a", prev: "" },
    };
    expect(Object.keys(wireItem(row).fields)).toEqual(["sidebar.projectIds", "future.preference"]);
  });
});
