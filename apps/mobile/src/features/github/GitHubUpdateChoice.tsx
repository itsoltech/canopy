import { useState } from "react";
import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { SettingToggle } from "../settings/SettingsGroup";

export function GitHubUpdateChoice({ account }: { account: github.GitHubAccount }) {
  const { client, queries } = useSession();
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
      <SettingToggle
        title="Use this account for update checks"
        description="Used when the public release index is unavailable. Updates work without an account."
        value={!!read.data?.enabled && read.data.accountId === account.id}
        disabled={busy || !read.data || account.status !== "connected"}
        onChange={(value) => void change(value)}
      />
      {!!error && <Notice error>{error}</Notice>}
      {!!read.error && (
        <>
          <Notice error>Could not load update preferences. Check the connection and try again.</Notice>
          <Button title="Retry" size="sm" onPress={() => void read.reload().catch(() => {})} />
        </>
      )}
    </View>
  );
}
