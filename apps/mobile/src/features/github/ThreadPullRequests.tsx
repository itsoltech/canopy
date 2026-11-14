import { useState } from "react";
import { Text, View } from "react-native";
import type { ui, github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { LinkPullRequest } from "./LinkPullRequest";
import { CreatePullRequest } from "./CreatePullRequest";
import { LinkedPullRequestRow } from "./LinkedPullRequestRow";
import { pullRequestsRefreshing } from "@canopy/domain/github-pr";
import { useQueryRefresh } from "../../state/query-refresh";

export function ThreadPullRequests({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { client, queries, online } = useSession();
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const key = `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}:${offset}`;

  const read = useSharedQuery<github.ThreadPullRequestsResponse>(
    key,
    () => client!.api.listThreadPullRequests({ threadId: thread.id, pageSize: 20, offset }),
    !!client,
    60_000,
  );

  // Re-read soon while the gateway refreshes stale links in the background.
  useQueryRefresh(key, pullRequestsRefreshing(read.data) ? 3_000 : 60_000, online);

  const links =
    read.data?.links ??
    (thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "", currentBranch: false }] : []);

  const total = read.data?.totalCount ?? thread.pullRequestCount;

  return (
    <View style={{ gap: 10, minWidth: 0 }}>
      <Text style={[styles.label, { color: c.text }]}>Pull requests · {total}</Text>
      {(expanded ? links : links.slice(0, 4)).map((link) => (
        <LinkedPullRequestRow
          key={link.summary?.ref?.id}
          link={link}
          threadId={thread.id}
          stale={!!read.data?.stale}
          onClose={onClose}
          onRetry={async (id) => {
            // The refresh records its reason on the gateway; the list shows it either way.
            await client?.api.refreshPullRequest({ pullRequestId: id }).catch(() => {});
            await read.reload();
          }}
        />
      ))}
      {expanded && total > 20 && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Button
            variant="ghost"
            size="sm"
            title="Previous"
            disabled={!offset}
            onPress={() => setOffset(Math.max(0, offset - 20))}
          />
          <Text style={{ color: c.text }}>
            {offset + 1}–{Math.min(offset + 20, total)} of {total}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            title="Next"
            disabled={!read.data?.nextOffset}
            onPress={() => setOffset(read.data?.nextOffset ?? 0)}
          />
        </View>
      )}
      {total > 4 && (
        <Button
          variant="ghost"
          size="sm"
          title={expanded ? "Show less" : `Show ${total - 4} more`}
          onPress={() => {
            if (expanded) setOffset(0);
            setExpanded(!expanded);
          }}
        />
      )}
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
      <LinkPullRequest
        visible={linking}
        onClose={() => setLinking(false)}
        threadId={thread.id}
        revision={read.data?.revision ?? thread.pullRequestRevision}
        onlinked={(value) => {
          queries.set(key, value);
        }}
      />
      {!read.data?.hasCurrentBranch && !links.some((link) => link.currentBranch) && (
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
