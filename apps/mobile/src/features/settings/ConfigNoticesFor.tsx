import type { ui } from "@canopy/contracts";
import { useSettingsResource } from "./resource";
import { SharedConfiguration } from "./SharedConfiguration";

/** The shared-configuration notices of one settings area (web: ConfigNotices with `match`); nothing without any. */
export function ConfigNoticesFor({
  match,
  onChanged,
}: {
  match: (notice: ui.ConfigNotice) => boolean;
  onChanged?: () => void;
}) {
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const notices = resource.data?.configNotices.filter(match) ?? [];

  if (!notices.length) return null;

  return (
    <SharedConfiguration
      notices={notices}
      onChanged={() => {
        void resource.reload();
        onChanged?.();
      }}
    />
  );
}
