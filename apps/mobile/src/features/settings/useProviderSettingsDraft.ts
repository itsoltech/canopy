import { useEffect, useRef, useState } from "react";
import { Provider } from "@canopy/contracts";
import { claudeProviderSettingsProblem } from "@canopy/domain/provider-settings-json";

export function useProviderSettingsDraft(harness: Provider, stored = "") {
  const [settingsText, setSettingsText] = useState<string>();
  const latest = useRef<string | undefined>(undefined);
  const [checked, setChecked] = useState<{ source: string; problem: string | undefined }>();
  const source = harness === Provider.CLAUDE ? settingsText : undefined;
  const pending = source !== undefined && checked?.source !== source;
  const problem = source === undefined ? undefined : checked?.problem;
  const saveBlocked = pending || !!problem;

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setChecked({ source, problem: claudeProviderSettingsProblem(source) }), 180);

    return () => clearTimeout(timer);
  }, [pending, source]);

  return {
    settingsText,
    value: settingsText ?? stored,
    problem,
    saveBlocked,
    canSave: () => !saveBlocked && latest.current === settingsText,
    change: (next: string | undefined) => {
      latest.current = next;
      setSettingsText(next);
    },
  };
}
