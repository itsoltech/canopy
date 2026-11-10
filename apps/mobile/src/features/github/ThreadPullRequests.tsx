import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui, github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { LinkPullRequest } from "./LinkPullRequest";

export function ThreadPullRequests({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { client, queries, online } = useSession();
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  const key = `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}`;

  const read = useSharedQuery<github.ThreadPullRequestsResponse>(
    key,
    () => client!.api.listThreadPullRequests({ threadId: thread.id }),
    !!client,
    60_000,
  );

  const links = read.data?.links ?? (thread.newestPullRequest ? [{ summary: thread.newestPullRequest }] : []);

  async function unlink(id: string) {
    if (!client) return;
    setError("");

    try {
      queries.set(
        key,
        await client.api.unlinkThreadPullRequest({
          threadId: thread.id,
          pullRequestId: id,
          expectedRevision: read.data?.revision ?? thread.pullRequestRevision,
        }),
      );
    } catch {
      setError("Could not unlink this pull request. Refresh, then retry.");
    }
  }

  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <Text style={[styles.label, { color: c.text }]}>Pull requests</Text>
      {!links.length && <Text style={[styles.meta, { color: c.muted }]}>No pull requests yet</Text>}
      {(expanded ? links : links.slice(0, 1)).map((link) => {
        const pr = link.summary;

        if (!pr?.ref) return null;

        return (
          <View
            key={pr.ref.id}
            style={{ gap: 6, minWidth: 0, borderBottomWidth: 1, borderBottomColor: c.line, paddingBottom: 10 }}
          >
            <Button
              title={pr.title || `${pr.ref.repositoryName} #${pr.ref.number}`}
              onPress={() => {
                onClose();
                router.push({ pathname: "/pull-request/[id]", params: { id: pr.ref!.id, threadId: thread.id } });
              }}
            />
            <Text selectable style={[styles.meta, { color: c.muted }]}>
              {pr.ref.repositoryName} #{pr.ref.number} · {pr.state}
            </Text>
            <Text style={[styles.meta, { color: c.muted }]}>
              Checks: {pr.checksState || "unavailable"} · {pr.checksCount}
            </Text>
            {read.data?.stale && pr.verifiedAt && (
              <Text style={[styles.meta, { color: c.muted }]}>
                Last verified {timestampDate(pr.verifiedAt).toLocaleString()}
              </Text>
            )}
            <Button
              size="sm"
              title="Unlink"
              disabled={!online || read.data?.stale}
              onPress={() => void unlink(pr.ref!.id)}
            />
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
      {!!(error || read.error) && (
        <>
          <Notice error>{error || "Could not load pull requests. Check the connection, then retry."}</Notice>
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
