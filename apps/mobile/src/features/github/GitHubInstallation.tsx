import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { Chevron, Expand } from "../../ui/MotionViews";
import { Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { GitHubActions } from "./GitHubActions";
import { GitHubRepositories } from "./GitHubRepositories";

export function GitHubInstallation({
  accountId,
  installation,
  installUrl,
}: {
  accountId: string;
  installation: github.GitHubInstallation;
  installUrl: string;
}) {
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const openGitHub = (url: string) =>
    void Linking.openURL(url).catch(() => setError("Could not open GitHub. Check your browser, then retry."));

  return (
    <View style={{ minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={installation.login}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Chevron open={open} />
          <Text numberOfLines={1} style={[type.chrome, { flex: 1, color: c.text }]}>
            {installation.login}
          </Text>
          {installation.suspended && <Text style={[type.meta, { color: c.muted }]}>Suspended</Text>}
        </Pressable>
        <GitHubActions
          name={installation.login}
          actions={[
            { label: "Manage repositories", run: () => openGitHub(installation.manageUrl) },
            ...(installUrl ? [{ label: "Install on another account", run: () => openGitHub(installUrl) }] : []),
          ]}
        />
      </View>
      {!!error && <Notice error>{error}</Notice>}
      <Expand open={open} style={{ paddingTop: 8, paddingLeft: 24, paddingBottom: 8 }}>
        {installation.suspended ? (
          <Notice>This installation is suspended. Ask its administrator to restore access.</Notice>
        ) : (
          <GitHubRepositories accountId={accountId} installationId={installation.installationId} />
        )}
      </Expand>
    </View>
  );
}
