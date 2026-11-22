import { Linking, Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";
import { SmallButton } from "../../ui/SmallButton";
import { useMobilePush } from "../notifications/PushProvider";
import { SettingToggle } from "./SettingsGroup";

const statusText = {
  checking: "Checking push support…",
  idle: "",
  buildUnavailable: "Install a version of Canopy with push support to use system notifications.",
  managedBuildUnavailable: "Update Canopy to use system notifications from this gateway.",
  managedDeviceUnavailable: "This device cannot verify Canopy with the gateway. Use a supported device.",
  desktopRelayUnavailable: "Set up a push relay in Settings → Network access on your paired desktop.",
  gatewayUnavailable:
    "System notifications are unavailable. Set up a push relay in the gateway’s Network access settings.",
  enabling: "Setting up system notifications…",
  verifying: "Verifying Canopy on this device…",
  enabled: "",
  disabling: "Turning off system notifications…",
  permission: "Canopy needs permission to show system notifications.",
  settings: "Canopy notifications are blocked in your device settings.",
  retryChecking: "Could not check availability. Check your connection.",
  retryEnabling: "Could not turn on system notifications. Check your connection.",
  retryVerifying: "Could not verify Canopy on this device.",
  retryDisabling: "Could not finish turning off system notifications.",
  saveFailed: "Could not save your choice. Change the setting again.",
};

export function MobilePushSettings() {
  const { registration, state } = useMobilePush();
  const c = useColors();
  const type = useTypography();

  if (!registration || !state) return null;
  const { canEnable, saving, phase, requested } = state;
  const status = statusText[phase];

  return (
    <View style={{ gap: 8 }}>
      <SettingToggle
        title="System notifications"
        description="Your device decrypts notification previews and shows them according to your lock screen settings."
        value={requested}
        disabled={saving || (!requested && !canEnable)}
        onChange={(enabled) => void registration.setEnabled(enabled)}
      />
      {status !== "" && (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
          {status}
        </Text>
      )}
      {phase === "permission" && <SmallButton title="Allow notifications" onPress={registration.retry} />}
      {phase === "settings" && (
        <SmallButton title="Open device settings" onPress={() => void Linking.openSettings().catch(() => {})} />
      )}
      {(phase === "desktopRelayUnavailable" || phase === "gatewayUnavailable") && (
        <SmallButton title="Check again" onPress={registration.refresh} />
      )}
      {phase.startsWith("retry") && <SmallButton title="Retry" onPress={registration.retry} />}
    </View>
  );
}
