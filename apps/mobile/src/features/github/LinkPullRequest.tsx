import { FlatList, Pressable, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { pullRequestPickerItems } from "@canopy/domain/github-pr-picker";
import { SearchField } from "../../ui/SearchField";
import { Icon } from "../../ui/Icon";
import { Overlay } from "../../ui/Overlay";
import { ListSkeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { PullRequestPickerFooter } from "./PullRequestPickerFooter";
import { PullRequestPickerHeader } from "./PullRequestPickerHeader";
import { RepositoryPullRequestRow } from "./RepositoryPullRequestRow";
import { usePullRequestPicker } from "./usePullRequestPicker";

export function LinkPullRequest({
  threadId,
  revision,
  onlinked,
  visible,
  onClose,
}: {
  threadId: string;
  revision: bigint;
  onlinked: (value: github.ThreadPullRequestsResponse) => void;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const p = usePullRequestPicker(threadId, visible, revision, onlinked);

  return (
    <Overlay visible={visible} onClose={onClose} label="Link pull request">
      <PullRequestPickerHeader picker={p} />
      <View style={{ paddingHorizontal: 12 }}>
        <SearchField
          label="Find a pull request"
          value={p.query}
          onChange={p.setQuery}
          placeholder="Search or paste a link"
        />
      </View>
      <FlatList
        data={pullRequestPickerItems(p.query, p.data)}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
        style={{ flexGrow: 0 }}
        renderItem={({ item }) =>
          item.pr ? (
            <RepositoryPullRequestRow pr={item.pr} disabled={p.busy} onSelect={() => void p.link(item)} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ disabled: p.busy || item.linked }}
              disabled={p.busy || item.linked}
              onPress={() => void p.link(item)}
              style={({ pressed }) => ({
                minHeight: 44,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 8,
                borderRadius: 8,
                backgroundColor: pressed ? c.pressed : "transparent",
                opacity: item.linked ? 0.5 : 1,
              })}
            >
              <Icon name="link" />
              <Text numberOfLines={1} style={[styles.overlay, { color: c.text, flex: 1 }]}>
                {item.label}
              </Text>
            </Pressable>
          )
        }
        onEndReached={() => void p.more()}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          p.loading ? (
            <ListSkeleton rows={3} />
          ) : p.data?.state === "ready" ? (
            <Text style={[styles.overlayMeta, { color: c.muted, padding: 12 }]}>
              {p.data.nextCursor
                ? "Load more to find pull requests"
                : p.query
                  ? "No matching pull requests"
                  : p.filter === "open"
                    ? "No open pull requests"
                    : "No pull requests yet"}
            </Text>
          ) : undefined
        }
        ListFooterComponent={<PullRequestPickerFooter picker={p} {...{ threadId, revision, onlinked }} />}
      />
    </Overlay>
  );
}
