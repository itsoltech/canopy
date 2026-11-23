import { Diff } from "../../ui/Diff";
import { useDevicePreferences } from "./device-preferences";
import { createSettingsViewState } from "./SettingsScroll";

const usePreview = createSettingsViewState<{ fileState: string; open: boolean } | undefined>(undefined);

export function SettingsDiffPreview({ diff, label }: { diff: string; label: string }) {
  const { values } = useDevicePreferences();
  const fileState = values.diffFileState;
  const [preview, setPreview] = usePreview();

  // A new default takes effect in the preview even if the user toggled it manually.
  if (preview && preview.fileState !== fileState) setPreview(undefined);

  return (
    <Diff
      diff={diff}
      label={label}
      open={preview?.fileState === fileState ? preview.open : fileState === "expanded"}
      onOpenChange={(open) => setPreview({ fileState, open })}
    />
  );
}
