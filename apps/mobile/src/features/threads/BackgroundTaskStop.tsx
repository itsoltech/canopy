import { useState } from "react";
import { View } from "react-native";
import { useSession } from "../../state/session";
import { Notice } from "../../ui/components";
import { IconButton } from "../../ui/Button";

export function BackgroundTaskStop({
  threadId,
  itemId,
  disabled,
}: {
  threadId: string;
  itemId: string;
  disabled: boolean;
}) {
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function stop() {
    if (!client || busy || disabled) return;
    setBusy(true);
    setError("");

    try {
      await client.api.stopBackgroundTask({ threadId, itemId });
    } catch {
      setError("Could not stop the task. Check the connection and retry.");
      setBusy(false);
    }
  }

  return (
    <View>
      <IconButton
        icon="stop"
        label={busy ? "Stopping…" : "Stop task"}
        size="sm"
        busy={busy}
        disabled={disabled}
        onPress={() => void stop()}
      />
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
