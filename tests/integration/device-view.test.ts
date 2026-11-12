import { describe, expect, test } from "bun:test";
import {
  DeviceViewPreferences,
  deviceViewStorageKey,
  deviceSidebarSettings,
  legacyDeviceView,
} from "@canopy/domain/device-view";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { materializeSettings, settingsValues } from "../../apps/gateway/src/config-sync/settings.ts";
import { emptyRecord } from "../../apps/gateway/src/config-sync/persistence.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";

function deviceStorage() {
  const records = new Map<string, string>();

  return {
    open(scope = "gateway-a") {
      const key = deviceViewStorageKey(scope);

      const preferences = new DeviceViewPreferences(
        () => {},
        (saved) => records.set(key, saved),
      );

      preferences.load(records.get(key) ?? null);

      return preferences;
    },
  };
}

describe("device view persistence for clients of the same owner", () => {
  test("filters migrate once per gateway and device while account pins still follow the owner", () => {
    const legacy = create(ui.UserSettingsSchema, {
      sidebar: {
        projectIds: ["project-a"],
        groupByProject: true,
        projectOrder: ui.ProjectOrder.NAME,
        workingSection: true,
        pinnedThreadIds: ["thread-a"],
      },
    });

    const storage = deviceStorage();
    const a = storage.open();
    const phone = deviceStorage().open();
    a.initialize(legacyDeviceView(legacy));
    phone.initialize(legacyDeviceView(legacy));
    a.set({ projectIds: [], groupByProject: false, projectOrder: ui.ProjectOrder.ACTIVITY, workingSection: false });
    legacy.sidebar!.projectIds = ["project-b"];
    legacy.sidebar!.pinnedThreadIds = ["thread-b"];
    const reopened = storage.open();
    reopened.initialize(legacyDeviceView(legacy));
    expect(deviceSidebarSettings(legacy.sidebar, reopened.values)).toMatchObject({
      projectIds: [],
      groupByProject: false,
      projectOrder: ui.ProjectOrder.ACTIVITY,
      workingSection: false,
      pinnedThreadIds: ["thread-b"],
    });
    expect(phone.values.projectIds).toEqual(["project-a"]);
    const otherGateway = storage.open("gateway-b");
    otherGateway.initialize({ projectIds: ["other-project"] });
    otherGateway.set({ sidebarWidth: 400 });
    expect(storage.open().values).toEqual(reopened.values);
    expect(storage.open("gateway-b").values.projectIds).toEqual(["other-project"]);
  });

  test("disclosure and geometry changes stay on device A and survive reopening without reseeding", () => {
    const legacy = { archivedThreadsExpanded: true, sidebarWidth: 320, sidebarCollapsed: true };
    const aStorage = deviceStorage();
    const bStorage = deviceStorage();
    const a = aStorage.open();
    const b = bStorage.open();
    a.initialize(legacy);
    b.initialize(legacy);
    a.set({
      archivedThreadsExpanded: false,
      archivedBotsExpanded: true,
      sidebarCollapsed: false,
      sidebarWidth: 0,
      pullRequestWidth: 960,
    });
    a.initialize(legacy);
    expect(a.values).toMatchObject({
      archivedThreadsExpanded: false,
      archivedBotsExpanded: true,
      sidebarWidth: 0,
      pullRequestWidth: 960,
    });
    expect(b.values).toMatchObject({
      archivedThreadsExpanded: true,
      archivedBotsExpanded: false,
      sidebarCollapsed: true,
      sidebarWidth: 320,
      pullRequestWidth: 0,
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

  test("malformed storage recovers, partial records seed missing filters, widths stay bounded", () => {
    const preferences = deviceStorage().open();
    preferences.load('{"archivedThreadsExpanded":false,"sidebarWidth":9000}');
    preferences.initialize({
      archivedThreadsExpanded: true,
      sidebarCollapsed: true,
      projectIds: ["project-a"],
      groupByProject: true,
    });
    expect(preferences.values).toMatchObject({
      archivedThreadsExpanded: false,
      sidebarCollapsed: true,
      sidebarWidth: 560,
      projectIds: ["project-a"],
      groupByProject: true,
    });
    preferences.load("not json");
    expect(preferences.values.archivedThreadsExpanded).toBe(false);
    preferences.set({ sidebarWidth: 40 });
    expect(preferences.values.sidebarWidth).toBe(220);
    preferences.set({ pullRequestWidth: 9000 });
    expect(preferences.values.pullRequestWidth).toBe(1200);
    preferences.set({ pullRequestWidth: 40 });
    expect(preferences.values.pullRequestWidth).toBe(320);
    preferences.set({ pullRequestWidth: 0 });
    expect(preferences.values.pullRequestWidth).toBe(0);
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
    expect(fields["sidebar.projectIds"]).toBeUndefined();
    expect(fields["sidebar.workingSection"]).toBeUndefined();
    expect(
      materializeSettings(
        stored,
        {
          "sidebar.archivedExpanded": false,
          "appearance.sidebarCollapsed": false,
          "sidebar.projectIds": [],
          "sidebar.workingSection": false,
        },
        "a",
      ),
    ).toEqual(stored);
    const row = emptyRecord("settings", "account");
    row.fields = {
      "sidebar.archivedExpanded": { value: true, hlc: "1.0.a", prev: "" },
      "appearance.sidebarWidth": { value: 320, hlc: "1.0.a", prev: "" },
      "sidebar.projectIds": { value: ["project"], hlc: "1.0.a", prev: "" },
      "future.preference": { value: true, hlc: "1.0.a", prev: "" },
    };
    expect(Object.keys(wireItem(row).fields)).toEqual(["future.preference"]);
  });
});
