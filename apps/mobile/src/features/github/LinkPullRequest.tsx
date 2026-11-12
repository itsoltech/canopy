import { FlatList, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Field } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { SheetDragArea, SheetCloseButton } from "../../ui/SheetDragArea";
import { Segmented } from "../../ui/Segmented";
import { ListSkeleton } from "../../ui/Skeleton";
import { styles, useColors } from "../../ui/theme";
import { PullRequestPickerFooter } from "./PullRequestPickerFooter";
import { PullRequestPickerAccount } from "./PullRequestPickerAccount";
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

  const directUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(p.query.trim())
    ? p.query.trim()
    : /^#?[1-9][0-9]*$/.test(p.query.trim()) && p.data?.repositoryName
      ? `https://github.com/${p.data.repositoryName}/pull/${p.query.trim().replace(/^#/, "")}`
      : "";

  return (
    <Overlay visible={visible} onClose={onClose} label="Link pull request">
      <SheetDragArea
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.overlayHeading, { color: c.muted, flex: 1 }]}>
          Link pull request
        </Text>
        <SheetCloseButton label="Close picker" />
      </SheetDragArea>
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        {!!p.data?.repositoryName && (
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
            {p.data.repositoryName}
          </Text>
        )}
        {p.data?.selection && (p.data.selection.candidates.length > 1 || p.data.state === "choose_account") && (
          <PullRequestPickerAccount
            selection={p.data.selection}
            disabled={p.busy || p.loading}
            onchoose={(id) => void p.choose(id)}
          />
        )}
        <Segmented
          value={p.filter}
          onChange={p.setFilter}
          options={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
          ]}
        />
        <Field
          label="Find a pull request"
          value={p.query}
          onChangeText={p.setQuery}
          placeholder="#123, title, branch, author or URL"
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <FlatList
        data={p.data?.items ?? []}
        keyExtractor={(pr) => String(pr.number)}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
        style={{ flexGrow: 0 }}
        renderItem={({ item }) => (
          <RepositoryPullRequestRow pr={item} disabled={p.busy} onSelect={(pr) => void p.link(pr)} />
        )}
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
        ListFooterComponent={<PullRequestPickerFooter picker={p} {...{ threadId, revision, onlinked, directUrl }} />}
      />
    </Overlay>
  );
}
