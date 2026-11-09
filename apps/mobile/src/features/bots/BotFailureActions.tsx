import { useRef, useState } from "react";
import { View } from "react-native";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { useComputerHome } from "../computers/presence";
import { BotSettings } from "./BotSettings";

/** Retry the failed input, or fix its worker/model before retrying. */
export function BotFailureActions({
  botId,
  retryable,
  disabled,
}: {
  botId: string;
  retryable: boolean;
  disabled: boolean;
}) {
  const { client, online, bots } = useSession();
  const bot = bots.find((row) => row.id === botId);
  const home = useComputerHome(bot?.nodeId);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const blocked = disabled || !online || home.away;

  async function retry() {
    if (!client || blocked || !retryable || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");

    try {
      await client.api.retryBot({ botId }, { timeoutMs: 20_000 });
    } catch {
      setError("Could not retry the reply. Check the connection and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {retryable && <Button title="Retry" size="sm" disabled={blocked} busy={busy} onPress={() => void retry()} />}
        {bot && (
          <Button
            title="Change model or worker"
            size="sm"
            variant="ghost"
            disabled={blocked || busy}
            onPress={() => setEditing(true)}
          />
        )}
      </View>
      {error ? <Notice error>{error}</Notice> : null}
      {editing && bot && <BotSettings bot={bot} onClose={() => setEditing(false)} />}
    </View>
  );
}
