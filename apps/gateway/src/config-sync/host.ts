import type { ui } from "@canopy/contracts";

/** Validation and live notifications supplied by the gateway that owns the materialized domain rows. */
export type SharedHost = {
  validateSettings?(request: ui.UpdateUserSettingsRequest): Promise<void>;
  validateProjectSettings?(defaults: ui.ThreadDefaults): Promise<void>;
  settingsChanged?(cliChanged?: boolean): Promise<void>;
  providersChanged?(workerIds: readonly string[]): Promise<void>;
  projectsChanged?(): Promise<void>;
};
