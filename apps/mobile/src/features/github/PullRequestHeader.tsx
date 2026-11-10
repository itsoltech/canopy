import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { formatAge } from "@canopy/domain/format";
import { Icon } from "../../ui/Icon";
import { font, useColors, useTypography } from "../../ui/theme";
import { GitHubAvatar } from "./GitHubAvatar";
import { GitHubActions } from "./GitHubActions";
import { PullRequestStatus } from "./PullRequestStatus";

export function PullRequestHeader({
  snapshot,
  busy,
  onrefresh,
  onunlink,
  onmessage,
  oncontext,
}: {
  snapshot: github.PullRequestSnapshot;
  busy: boolean;
  onrefresh: () => void;
  onunlink?: (() => void) | undefined;
  onmessage: (value: string) => void;
  oncontext?: ((action: string) => void) | undefined;
}) {
  const c = useColors();
  const type = useTypography();
  const pr = snapshot.summary;
  const ref = pr?.ref;
  const url = `https://github.com/${ref?.repositoryName}/pull/${ref?.number}`;

  async function copy(value: string, message: string) {
    try {
      await Clipboard.setStringAsync(value);
      onmessage(message);
    } catch {
      onmessage("Could not copy. Select the text and copy it manually.");
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="link"
          hitSlop={8}
          style={{ flex: 1, minWidth: 0 }}
          onPress={() =>
            void Linking.openURL(url).catch(() => onmessage("Could not open GitHub. Check the connection, then retry."))
          }
        >
          <Text numberOfLines={1} style={[type.small, { color: c.muted }]}>
            {ref?.repositoryName} <Text style={{ color: c.text }}>#{ref?.number}</Text>
          </Text>
        </Pressable>
        <PullRequestStatus state={pr?.state ?? ""} iconOnly />
        <GitHubActions
          name="Pull request"
          actions={[
            { label: busy ? "Refreshing…" : "Refresh", run: onrefresh, disabled: busy },
            ...(oncontext
              ? [
                  { label: "Ask a question", run: () => oncontext("question"), disabled: busy },
                  { label: "Explain this PR", run: () => oncontext("explain"), disabled: busy },
                  { label: "Fix findings in this thread", run: () => oncontext("findings"), disabled: busy },
                ]
              : []),
            {
              label: "Open on GitHub",
              run: () =>
                void Linking.openURL(url).catch(() =>
                  onmessage("Could not open GitHub. Check the connection, then retry."),
                ),
            },
            { label: "Copy link", run: () => void copy(url, "PR link copied") },
            { label: "Copy PR number", run: () => void copy(String(ref?.number), "PR number copied") },
            ...(onunlink ? [{ label: "Unlink", run: onunlink, disabled: busy }] : []),
          ]}
        />
      </View>
      <Text
        accessibilityRole="header"
        numberOfLines={2}
        style={[type.body, { fontFamily: font.semibold, color: c.text }]}
      >
        {pr?.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <GitHubAvatar login={snapshot.author} userId="" compact />
        <Text numberOfLines={1} style={[type.meta, { flex: 1, color: c.text }]}>
          {snapshot.author}
        </Text>
        <Text style={[type.meta, { color: c.muted }]}>
          updated {formatAge(pr?.updatedAt) === "now" ? "now" : `${formatAge(pr?.updatedAt)} ago`}
        </Text>
      </View>
      <Text numberOfLines={1} style={[type.mono, { color: c.muted }]}>
        {snapshot.baseRef} ← {snapshot.headRef}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={[type.meta, { color: c.muted }]}>
          {snapshot.files} files <Text style={{ color: c.success }}>+{snapshot.additions}</Text>{" "}
          <Text style={{ color: c.danger }}>−{snapshot.deletions}</Text>
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy checkout command"
          hitSlop={8}
          onPress={() => void copy(`gh pr checkout ${ref?.number}`, "Checkout command copied")}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderRadius: 6,
            backgroundColor: pressed ? c.pressed : c.well,
          })}
        >
          <Text style={[type.meta, { fontFamily: type.mono.fontFamily, color: c.text }]}>
            gh pr checkout {ref?.number}
          </Text>
          <Icon name="copy" />
        </Pressable>
      </View>
    </View>
  );
}
