import { Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography, font } from "../../ui/theme";
import { confirmAction } from "../settings/resource";
import { GitHubInstallation } from "./GitHubInstallation";
import { useGitHubCatalogue } from "./useGitHubCatalogue";

export function GitHubAccount({
  account,
  installUrl,
  onchanged,
}: {
  account: github.GitHubAccount;
  installUrl: string;
  onchanged: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  const { installations, next, busy, loaded, error, generation, load, disconnect, setError } = useGitHubCatalogue(
    account,
    onchanged,
  );

  const open = (url: string) =>
    void Linking.openURL(url).catch(() => setError("Could not open GitHub. Check your browser, then retry."));

  return (
    <View style={{ gap: 12, minWidth: 0, borderTopWidth: 1, borderColor: c.line, paddingVertical: 16 }}>
      <Text style={[type.body, { color: c.text, fontFamily: font.semibold }]}>{account.login}</Text>
      <Text style={[type.body, { color: c.muted }]}>
        {account.host} · {account.authKind === "pat" ? "Personal access token" : "GitHub App"} ·{" "}
        {account.status === "connected"
          ? "Connected"
          : account.status === "needs_reconnect"
            ? "Reconnect required"
            : "Disconnected"}
      </Text>
      {account.status !== "disconnected" && (
        <Button
          title="Disconnect account"
          size="sm"
          disabled={busy}
          onPress={() =>
            confirmAction(
              "Disconnect account",
              "This removes this account’s access from this computer. To revoke authorization on every computer, open GitHub Settings → Applications → Authorized GitHub Apps.",
              () => void disconnect(),
            )
          }
        />
      )}
      {!!error && (
        <View style={{ gap: 8 }}>
          <Notice error>{error}</Notice>
          <Button title="Retry" size="sm" disabled={busy} onPress={() => void load(0, true)} />
        </View>
      )}
      {account.status === "connected" &&
        (account.authKind === "pat" ? (
          <Text style={[type.body, { color: c.muted }]}>
            This account uses the personal access token you selected in Connectors.
          </Text>
        ) : (
          <View style={{ gap: 12 }}>
            {busy && !loaded && <Text style={[type.body, { color: c.muted }]}>Loading installations…</Text>}
            {installations.map((installation) => (
              <GitHubInstallation
                key={`${generation}:${installation.installationId}`}
                accountId={account.id}
                installation={installation}
              />
            ))}
            {loaded && !installations.length && (
              <Text style={[type.body, { color: c.muted }]}>
                No accessible installations. Install Canopy and choose repositories, or ask an organization
                administrator to approve access.
              </Text>
            )}
            {!!installUrl && <Button title="Install Canopy" size="sm" onPress={() => open(installUrl)} />}
            <Button title="Refresh installations" size="sm" disabled={busy} onPress={() => void load(0, true)} />
            {!!next && (
              <Button title="Load more installations" size="sm" disabled={busy} onPress={() => void load(next)} />
            )}
          </View>
        ))}
      <Button
        title="Manage authorization on GitHub"
        size="sm"
        onPress={() => open("https://github.com/settings/apps/authorizations")}
      />
    </View>
  );
}
