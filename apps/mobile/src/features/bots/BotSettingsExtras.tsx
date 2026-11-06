import { useState } from "react";
import { Text, View } from "react-native";
import { confirm } from "../../ui/Confirm";
import { router } from "expo-router";
import type { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ConnectorList, useConnectors } from "../connectors/Connectors";

export function BotSettingsExtras({
  bot,
  onClose,
  disabled,
}: {
  bot: bots.Bot;
  onClose: () => void;
  disabled: boolean;
}) {
  const { client } = useSession();
  const { list, error: connectionsError } = useConnectors(undefined, bot.id);
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(remove: boolean) {
    setBusy(true);

    try {
      if (remove) await client!.api.deleteBot({ botId: bot.id });
      else if (bot.archived) await client!.api.unarchiveBot({ botId: bot.id });
      else await client!.api.archiveBot({ botId: bot.id });
      onClose();

      if (remove) router.replace("/");
    } catch {
      setError(remove ? "Could not delete this bot. Try again." : "Could not archive this bot. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.heading, { color: c.text }]}>Connections</Text>
      {list ? (
        list.accounts.length ? (
          <ConnectorList list={list} />
        ) : (
          <Text style={[styles.meta, { color: c.muted }]}>No accounts are granted to this bot yet.</Text>
        )
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>Loading connections…</Text>
      )}
      {connectionsError ? <Notice error>{connectionsError}</Notice> : null}
      <Button
        title="Manage connector access"
        disabled={disabled || busy}
        onPress={() => {
          onClose();
          router.push({ pathname: "/settings", params: { section: "connectors" } });
        }}
      />
      <Text style={[styles.heading, { color: c.text }]}>Danger zone</Text>
      <Button
        title={bot.archived ? "Unarchive bot" : "Archive bot"}
        busy={busy}
        disabled={disabled}
        onPress={() => void act(false)}
      />
      <Button
        variant="danger"
        title="Delete bot…"
        disabled={disabled || busy}
        onPress={() =>
          confirm({
            title: "Delete bot?",
            description: `This deletes “${bot.configuration?.name || "Bot"}” and its conversation. You cannot undo this.`,
            confirm: "Delete bot",
            action: () => void act(true),
          })
        }
      />
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
