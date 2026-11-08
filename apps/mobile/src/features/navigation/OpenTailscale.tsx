import { Alert, Linking, Platform } from "react-native";
import { Button } from "../../ui/Button";

/** Android registers this navigation URL. Open directly: querying installed apps would need native config. */
export function OpenTailscale() {
  if (Platform.OS !== "android") return null;

  return (
    <Button
      title="Open Tailscale"
      size="sm"
      variant="ghost"
      onPress={() => {
        void Linking.openURL("tailscale://navigate/main/devices").catch(() => {
          Alert.alert("Could not open Tailscale", "Open the Tailscale app, then turn it off and on.", [
            { text: "Close" },
          ]);
        });
      }}
    />
  );
}
