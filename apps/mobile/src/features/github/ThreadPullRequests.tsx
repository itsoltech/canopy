import { useEffect, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import type { ui, github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { LinkPullRequest } from "./LinkPullRequest";
import { CreatePullRequest } from "./CreatePullRequest";
import { PullRequestStatus } from "./PullRequestStatus";
import { checkLook } from "@canopy/domain/github-pr";
import { Icon } from "../../ui/Icon";
import { toneColor } from "./presentation";
import { toast } from "../../ui/Toast";

export function ThreadPullRequests({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { client, queries, online } = useSession();
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const key = `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}`;
  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === "active") queries.invalidate(key);
    }, 60_000);

    return () => clearInterval(timer);
  }, [key, queries]);

  const read = useSharedQuery<github.ThreadPullRequestsResponse>(
    key,
    () => client!.api.listThreadPullRequests({ threadId: thread.id }),
    !!client,
    60_000,
  );

  const links =
    read.data?.links ??
    (thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "", currentBranch: false }] : []);

  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <Text style={[styles.label, { color: c.text }]}>Pull requests</Text>
      {!links.length && <Text style={[styles.meta, { color: c.muted }]}>No pull requests yet</Text>}
      {(expanded ? links : links.slice(0, 1)).map((link) => (
        <ThreadPullRequestRow
          key={link.summary?.ref?.id}
          link={link}
          threadId={thread.id}
          stale={!!read.data?.stale}
          onClose={onClose}
        />
      ))}
      {links.length > 1 && (
        <Button
          variant="ghost"
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
        variant="ghost"
        title={linking ? "Cancel" : "+ Link pull request"}
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
      {!links.some((link) => link.currentBranch) && (
        <Button
          variant="ghost"
          title="Create pull request"
          disabled={!online || read.data?.stale}
          onPress={() => setCreating(true)}
        />
      )}
      <CreatePullRequest
        threadId={thread.id}
        visible={creating}
        onClose={() => setCreating(false)}
        oncreated={() => void read.reload()}
        ondrafted={onClose}
      />
    </View>
  );
}

function ThreadPullRequestRow({
  link,
  threadId,
  stale,
  onClose,
}: {
  link: { summary?: github.PullRequestSummary | undefined; source: string; currentBranch: boolean };
  threadId: string;
  stale: boolean;
  onClose: () => void;
}) {
  const c = useColors(),
    pr = link.summary;

  if (!pr?.ref) return null;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        onLongPress={() => toast(`${pr.state}, checks ${checkLook(pr.checksState).label}`)}
        accessibilityRole="button"
        accessibilityLabel={`${pr.title}, ${pr.state}, checks ${checkLook(pr.checksState).label}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 48,
          borderRadius: 8,
          paddingHorizontal: 4,
          backgroundColor: pressed ? c.pressed : link.currentBranch ? c.well : undefined,
        })}
        onPress={() => {
          onClose();
          router.push({ pathname: "/pull-request/[id]", params: { id: pr.ref!.id, threadId } });
        }}
      >
        <PullRequestStatus state={pr.state} iconOnly />
        <Text numberOfLines={1} style={[styles.chrome, { flex: 1, color: c.text }]}>
          {pr.title || pr.ref.repositoryName}
        </Text>
        <Text style={[styles.chromeMeta, { color: c.muted }]}>#{pr.ref.number}</Text>
        <Icon name={checkLook(pr.checksState).icon} color={toneColor(c, checkLook(pr.checksState).tone)} />
      </Pressable>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          minHeight: 22,
          paddingHorizontal: 4,
        }}
      >
        {!!link.source && (
          <Text style={[styles.chromeMeta, { color: c.muted }]}>
            {link.source === "auto" ? "Linked automatically" : "Linked manually"}
          </Text>
        )}
        <Text style={[styles.chromeMeta, { color: c.muted }]}>{link.currentBranch ? "Current branch" : "History"}</Text>
      </View>
      {stale && pr.verifiedAt && (
        <Text style={[styles.meta, { color: c.muted }]}>
          Last verified {timestampDate(pr.verifiedAt).toLocaleString()}
        </Text>
      )}
    </View>
  );
}
