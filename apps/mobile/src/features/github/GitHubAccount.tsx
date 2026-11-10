import { useState } from "react";
import { Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { Expand } from "../../ui/MotionViews";
import { useColors, useTypography } from "../../ui/theme";
import { confirmAction } from "../settings/resource";
import { GitHubInstallation } from "./GitHubInstallation";
import { GitHubAccountRow } from "./GitHubAccountRow";
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
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const catalogue = useGitHubCatalogue(account, onchanged);
  const { installations, next, busy, loaded, error, generation, load, disconnect, setError } = catalogue;

  const openGitHub = (url: string) =>
    void Linking.openURL(url).catch(() => setError("Could not open GitHub. Check your browser, then retry."));

  const actions = [
    ...(account.authKind !== "pat"
      ? [
          {
            label: "Refresh installations",
            disabled: busy || account.status !== "connected",
            run: () => void load(0, true),
          },
        ]
      : []),
    ...(installUrl && account.authKind !== "pat"
      ? [{ label: "Install on another account", run: () => openGitHub(installUrl) }]
      : []),
    {
      label: "Manage authorization on GitHub",
      run: () => openGitHub("https://github.com/settings/apps/authorizations"),
    },
    {
      label: "Disconnect account",
      danger: true,
      disabled: busy || account.status === "disconnected",
      run: () =>
        confirmAction(
          "Disconnect account",
          "This removes this account’s access from this computer. To revoke authorization on every computer, open GitHub Settings → Applications → Authorized GitHub Apps.",
          () => void disconnect(),
        ),
    },
  ];

  return (
    <View style={{ minWidth: 0 }}>
      <GitHubAccountRow
        account={account}
        installations={catalogue.installationCount}
        repositories={catalogue.repositoryCount}
        open={open}
        onToggle={() => setOpen(!open)}
        actions={actions}
      />
      {!!error && (
        <View style={{ gap: 8, paddingVertical: 8 }}>
          <Notice error>{error}</Notice>
          <Button title="Retry" size="sm" disabled={busy} onPress={() => void load(0, true)} />
        </View>
      )}
      <Expand open={open} style={{ gap: 8, paddingTop: 8 }}>
        {account.status === "connected" &&
          (account.authKind === "pat" ? (
            <Text style={[type.meta, { color: c.muted }]}>
              This account uses the personal access token you selected in Connectors.
            </Text>
          ) : (
            <>
              {busy && !loaded && <Text style={[type.meta, { color: c.muted }]}>Loading installations…</Text>}
              {(all ? installations : installations.slice(0, 5)).map((installation) => (
                <GitHubInstallation
                  key={`${generation}:${installation.installationId}`}
                  accountId={account.id}
                  installation={installation}
                  installUrl={installUrl}
                />
              ))}
              {loaded && !installations.length && (
                <Text style={[type.meta, { color: c.muted }]}>
                  No accessible installations. Install Canopy and choose repositories, or ask an organization
                  administrator to approve access.
                </Text>
              )}
              {catalogue.installationCount > 5 && (
                <Button
                  title={all ? "Show fewer installations" : `Show all ${catalogue.installationCount} installations`}
                  variant="ghost"
                  size="sm"
                  onPress={() => setAll(!all)}
                />
              )}
              {all && !!next && (
                <Button title="Load more installations" size="sm" disabled={busy} onPress={() => void load(next)} />
              )}
            </>
          ))}
      </Expand>
    </View>
  );
}
