import { View } from "react-native";
import { IconButton } from "../../ui/Button";
import { StatusDot } from "../../ui/Badge";
import { useOpenSettingsSection } from "../settings/navigation";
import { bulkUpdatesAvailable, updatesRunning } from "./model";
import { usePhoneUpdates } from "./phone";
import { useUpdates } from "./state";

export function useAppUpdateHint() {
  const { snapshot, run } = useUpdates();
  const phone = usePhoneUpdates();

  if ((snapshot && updatesRunning(snapshot)) || phone.busy) return "Update in progress";

  if (
    (run && ["failed", "blocked"].includes(run.state)) ||
    phone.error ||
    phone.status.checkError ||
    phone.status.downloadError
  )
    return "Update failed";

  if ((snapshot && bulkUpdatesAvailable(snapshot)) || phone.status.isUpdateAvailable || phone.status.isUpdatePending)
    return "Updates available";

  return "";
}

export function AppUpdatesButton() {
  const openSettingsSection = useOpenSettingsSection();
  const hint = useAppUpdateHint();
  const failed = hint === "Update failed";
  const running = hint === "Update in progress";

  return (
    <View>
      <IconButton
        icon={failed ? "exclamation-circle" : "arrow-down-tray"}
        label={hint ? `Open app updates, ${hint.toLowerCase()}` : "Open app updates"}
        onPress={() => openSettingsSection("app-updates")}
      />
      {!!hint && !failed && (
        <View pointerEvents="none" style={{ position: "absolute", top: 7, right: 7 }}>
          <StatusDot tone={running ? "amber" : "sky"} active={running} />
        </View>
      )}
    </View>
  );
}
