import { Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Chevron } from "../../ui/MotionViews";
import { font, useColors, useTypography } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { GitHubActions, type GitHubAction } from "./GitHubActions";

export function GitHubAccountRow({
  account,
  installations,
  repositories,
  open,
  onToggle,
  actions,
}: {
  account: github.GitHubAccount;
  installations: number;
  repositories: number;
  open: boolean;
  onToggle: () => void;
  actions: GitHubAction[];
}) {
  const c = useColors();
  const type = useTypography();

  const status =
    account.status === "connected"
      ? "Connected"
      : account.status === "needs_reconnect"
        ? "Reconnect required"
        : "Disconnected";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${account.login}, ${status}${account.authKind !== "pat" && account.status === "connected" ? `, ${installations} ${installations === 1 ? "installation" : "installations"}, ${repositories} ${repositories === 1 ? "repo" : "repos"}` : ""}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          minHeight: 64,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          borderRadius: 8,
          backgroundColor: pressed ? c.inset : "transparent",
        })}
      >
        <GitHubAvatar accountId={account.id} login={account.login} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
            {account.login}
          </Text>
          <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
            {account.authKind === "pat" ? "Personal access token" : "GitHub App"} · {status}
          </Text>
          {account.authKind !== "pat" && account.status === "connected" && (
            <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
              {installations} {installations === 1 ? "installation" : "installations"} · {repositories}{" "}
              {repositories === 1 ? "repo" : "repos"}
            </Text>
          )}
        </View>
        <Chevron open={open} />
      </Pressable>
      <GitHubActions name={account.login} actions={actions} />
    </View>
  );
}
