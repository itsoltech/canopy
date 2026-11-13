import { Schema } from "effect";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { storedSidebarWidth } from "./appearance/sidebar.ts";
import type { ThreadSortMode } from "./thread-order.ts";

/** Desktop PR geometry in pixels; a narrow window may clamp below the preferred minimum. */
export const PULL_REQUEST_WIDTH = { default: 576, min: 320, max: 1200, minThread: 384 } as const;

const savedView = Schema.Struct({
  archivedThreadsExpanded: Schema.optionalKey(Schema.Boolean),
  archivedBotsExpanded: Schema.optionalKey(Schema.Boolean),
  sidebarCollapsed: Schema.optionalKey(Schema.Boolean),
  threadPanelCollapsed: Schema.optionalKey(Schema.Boolean),
  sidebarWidth: Schema.optionalKey(Schema.Number),
  pullRequestWidth: Schema.optionalKey(Schema.Number),
  projectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  groupByProject: Schema.optionalKey(Schema.Boolean),
  projectOrder: Schema.optionalKey(Schema.Literals([0, 1, 2])),
  workingSection: Schema.optionalKey(Schema.Boolean),
  threadSortMode: Schema.optionalKey(Schema.Literals(["activity", "created", "custom"])),
  lastSeenAppVersion: Schema.optionalKey(Schema.String),
  appUpdateFrom: Schema.optionalKey(Schema.String),
});

export type DeviceSidebarValues = Pick<
  ui.SidebarSettings,
  "projectIds" | "groupByProject" | "projectOrder" | "workingSection"
>;

export interface DeviceViewValues extends DeviceSidebarValues {
  threadSortMode: ThreadSortMode;
  lastSeenAppVersion: string;
  appUpdateFrom: string;
  archivedThreadsExpanded: boolean;
  archivedBotsExpanded: boolean;
  sidebarCollapsed: boolean;
  threadPanelCollapsed: boolean;
  sidebarWidth: number;
  pullRequestWidth: number;
}

export const deviceViewDefaults: DeviceViewValues = {
  threadSortMode: "activity",
  lastSeenAppVersion: "",
  appUpdateFrom: "",
  archivedThreadsExpanded: false,
  archivedBotsExpanded: false,
  sidebarCollapsed: false,
  threadPanelCollapsed: false,
  sidebarWidth: 0,
  pullRequestWidth: 0,
  projectIds: [],
  groupByProject: false,
  projectOrder: ui.ProjectOrder.ACTIVITY,
  workingSection: false,
};

/** Opaque gateway identity (web/desktop), or pairing identity (mobile); never a credential. */
export const deviceViewStorageKey = (scope: string) => `canopy.client-view.v2.${encodeURIComponent(scope)}`;

/** Only pins follow the account. All list filters and organization come from this client. */
export function deviceSidebarSettings(synced: ui.SidebarSettings | undefined, view: DeviceViewValues) {
  return create(ui.SidebarSettingsSchema, {
    pinnedThreadIds: synced?.pinnedThreadIds ?? [],
    pinnedBotIds: synced?.pinnedBotIds ?? [],
    projectIds: view.projectIds,
    groupByProject: view.groupByProject,
    projectOrder: view.projectOrder,
    workingSection: view.workingSection,
  });
}

/** Read old account view fields exclusively for the one-time migration. */
export function legacyDeviceView(user: ui.UserSettings): Partial<DeviceViewValues> {
  return {
    archivedThreadsExpanded: user.sidebar?.archivedExpanded ?? false,
    sidebarCollapsed: user.appearance?.sidebarCollapsed ?? false,
    threadPanelCollapsed: user.appearance?.threadPanelCollapsed ?? false,
    sidebarWidth: user.appearance?.sidebarWidth ?? 0,
    projectIds: user.sidebar?.projectIds ?? [],
    groupByProject: user.sidebar?.groupByProject ?? false,
    projectOrder: user.sidebar?.projectOrder ?? ui.ProjectOrder.ACTIVITY,
    workingSection: user.sidebar?.workingSection ?? false,
  };
}

/** Device storage only. Legacy account values seed missing fields once, including false and zero. */
export class DeviceViewPreferences {
  values = { ...deviceViewDefaults };
  #saved: Partial<DeviceViewValues> = {};
  #initialized = false;

  constructor(
    readonly changed: (values: DeviceViewValues) => void,
    readonly persist: (raw: string) => void,
  ) {}

  load(raw: string | null): void {
    this.#saved = {};

    if (raw) {
      try {
        const { projectIds, ...saved } = Schema.decodeUnknownSync(savedView)(JSON.parse(raw));
        this.#saved = { ...saved, ...(projectIds && { projectIds: [...projectIds] }) };
      } catch {
        // Invalid or obsolete storage uses the defaults and can be replaced on the next change.
      }
    }

    this.#publish({ ...deviceViewDefaults, ...this.#saved });
  }

  initialize(legacy: Partial<DeviceViewValues>): void {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#save({ ...deviceViewDefaults, ...legacy, ...this.#saved });
  }

  set(change: Partial<DeviceViewValues>): void {
    this.#save({ ...this.values, ...change });
  }

  #publish(values: DeviceViewValues): void {
    const width = values.pullRequestWidth;
    this.values = {
      ...values,
      sidebarWidth: storedSidebarWidth(values.sidebarWidth),
      pullRequestWidth:
        Number.isFinite(width) && width > 0
          ? Math.round(Math.min(PULL_REQUEST_WIDTH.max, Math.max(PULL_REQUEST_WIDTH.min, width)))
          : 0,
    };
    this.changed(this.values);
  }

  #save(values: DeviceViewValues): void {
    this.#publish(values);
    this.#saved = this.values;
    this.persist(JSON.stringify(this.values));
  }
}
