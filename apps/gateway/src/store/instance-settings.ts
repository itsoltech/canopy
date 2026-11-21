import { parseProviderSettings } from "@canopy/domain/provider-settings";
import { Effect } from "effect";
import type { Harness, StoredRuntime } from "./instance-config.ts";
import { Invalid } from "./errors.ts";

/** Validate the submitted text and preserve its formatting for the editor. */
export function providerSettingsText(harness: Harness, source: string): string | undefined {
  parseProviderSettings(harness, source);

  return source.trim() ? source : undefined;
}

export function settingsFrom(harness: Harness, source: string | undefined, current: string | undefined) {
  return Effect.try<Pick<StoredRuntime, "settingsText">, Invalid>({
    try: () => {
      const settingsText = source === undefined ? current : providerSettingsText(harness, source);

      return settingsText === undefined ? {} : { settingsText };
    },
    catch: (cause) => new Invalid(cause instanceof Error ? cause.message : "Invalid provider settings."),
  });
}
