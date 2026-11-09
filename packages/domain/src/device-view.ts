import { Schema } from "effect";
import { storedSidebarWidth } from "./appearance/sidebar.ts";

const savedView = Schema.Struct({
  archivedThreadsExpanded: Schema.optionalKey(Schema.Boolean),
  archivedBotsExpanded: Schema.optionalKey(Schema.Boolean),
  sidebarCollapsed: Schema.optionalKey(Schema.Boolean),
  threadPanelCollapsed: Schema.optionalKey(Schema.Boolean),
  sidebarWidth: Schema.optionalKey(Schema.Number),
});

export interface DeviceViewValues {
  archivedThreadsExpanded: boolean;
  archivedBotsExpanded: boolean;
  sidebarCollapsed: boolean;
  threadPanelCollapsed: boolean;
  sidebarWidth: number;
}

export const deviceViewDefaults: DeviceViewValues = {
  archivedThreadsExpanded: false,
  archivedBotsExpanded: false,
  sidebarCollapsed: false,
  threadPanelCollapsed: false,
  sidebarWidth: 0,
};

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
        this.#saved = Schema.decodeUnknownSync(savedView)(JSON.parse(raw));
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
    this.values = { ...values, sidebarWidth: storedSidebarWidth(values.sidebarWidth) };
    this.changed(this.values);
  }

  #save(values: DeviceViewValues): void {
    this.#publish(values);
    this.#saved = this.values;
    this.persist(JSON.stringify(this.values));
  }
}
