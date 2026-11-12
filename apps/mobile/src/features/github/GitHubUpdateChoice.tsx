import { useState } from "react";
import { Switch, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { useColors, useTypography } from "../../ui/theme";

export function GitHubUpdateChoice({ account }: { account: github.GitHubAccount }) {
  const { client, queries } = useSession();
  const c = useColors();
  const type = useTypography();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = `GitHubUpdateAccount:${splitId(account.id).node ?? "local"}`;
  const read = useSharedQuery(key, () => client!.api.getGitHubUpdateAccount({ homeId: account.id }), !!client);

  async function change(enabled: boolean) {
    if (!client) return;
    setBusy(true);
    setError("");

    try {
      queries.set(key, await client.api.setGitHubUpdateAccount({ homeId: account.id, accountId: account.id, enabled }));
    } catch {
      setError("Could not change update preferences. Reopen Settings to retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={[type.small, { flex: 1, color: c.text }]}>Use this account for update checks</Text>
        <Switch
          accessibilityLabel="Use this account for update checks"
          value={!!read.data?.enabled && read.data.accountId === account.id}
          disabled={busy || account.status !== "connected"}
          onValueChange={(value) => void change(value)}
        />
      </View>
      <Text style={[type.meta, { color: c.muted }]}>
        Used when the public release index is unavailable. Updates work without an account.
      </Text>
      {!!error && <Text style={[type.small, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}
