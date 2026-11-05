import type { ui } from "@canopy/contracts";

/** Validation and live notifications supplied by the gateway that owns the materialized domain rows. */
export type SharedHost = {
  validateSettings?(request: ui.UpdateUserSettingsRequest): Promise<void>;
  validateProjectSettings?(defaults: ui.ThreadDefaults): Promise<void>;
  settingsChanged?(cliChanged?: boolean): Promise<void>;
  providersChanged?(workerIds: readonly string[]): Promise<void>;
  projectsChanged?(): Promise<void>;
  /** The agent environment library changed: workers get the new desired state. */
  environmentChanged?(): Promise<void>;
  connectorsChanged?(): Promise<void>;
  /** Copies of other computers' worker records changed (ListWorkerRecords). */
  workerRecordsChanged?(): void;
};
