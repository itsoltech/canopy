import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { ui, github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { LinkPullRequest } from "./LinkPullRequest";
import { PullRequestStatus } from "./PullRequestStatus";
import { checkLook } from "@canopy/domain/github-pr";
import { Icon } from "../../ui/Icon";
import { toneColor } from "./presentation";

export function ThreadPullRequests({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { client, queries, online } = useSession();
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const key = `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}`;

  const read = useSharedQuery<github.ThreadPullRequestsResponse>(
    key,
    () => client!.api.listThreadPullRequests({ threadId: thread.id }),
    !!client,
    60_000,
  );

  const links = read.data?.links ?? (thread.newestPullRequest ? [{ summary: thread.newestPullRequest }] : []);

  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <Text style={[styles.label, { color: c.text }]}>Pull requests</Text>
      {!links.length && <Text style={[styles.meta, { color: c.muted }]}>No pull requests yet</Text>}
      {(expanded ? links : links.slice(0, 1)).map((link) => {
        const pr = link.summary;

        if (!pr?.ref) return null;

        return (
          <View key={pr.ref.id} style={{ minWidth: 0 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${pr.title}, ${pr.state}, checks ${checkLook(pr.checksState).label}`}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 48,
                borderRadius: 8,
                paddingHorizontal: 4,
                backgroundColor: pressed ? c.pressed : undefined,
              })}
              onPress={() => {
                onClose();
                router.push({ pathname: "/pull-request/[id]", params: { id: pr.ref!.id, threadId: thread.id } });
              }}
            >
              <PullRequestStatus state={pr.state} iconOnly />
              <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: c.text }]}>
                {pr.title || pr.ref.repositoryName}
              </Text>
              <Text style={[styles.chromeMeta, { color: c.muted }]}>#{pr.ref.number}</Text>
              <Icon name={checkLook(pr.checksState).icon} color={toneColor(c, checkLook(pr.checksState).tone)} />
            </Pressable>
            {read.data?.stale && pr.verifiedAt && (
              <Text style={[styles.meta, { color: c.muted }]}>
                Last verified {timestampDate(pr.verifiedAt).toLocaleString()}
              </Text>
            )}
          </View>
        );
      })}
      {links.length > 1 && (
        <Button
          size="sm"
          title={expanded ? "Show less" : `Show ${links.length - 1} more`}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {!!read.data?.detail && <Text style={[styles.meta, { color: c.muted }]}>{read.data.detail}</Text>}
      {!!read.error && (
        <>
          <Notice error>Could not load pull requests. Check the connection, then retry.</Notice>
          <Button title="Retry" onPress={() => void read.reload()} />
        </>
      )}
      <Button
        title={linking ? "Cancel" : "Link pull request"}
        disabled={!online || read.data?.stale}
        onPress={() => setLinking(!linking)}
      />
      {linking && (
        <LinkPullRequest
          threadId={thread.id}
          revision={read.data?.revision ?? thread.pullRequestRevision}
          onlinked={(value) => {
            queries.set(key, value);
            setLinking(false);
          }}
        />
      )}
    </View>
  );
}
