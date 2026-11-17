import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ui, github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Notice } from "../../ui/components";
import { Button, IconButton } from "../../ui/Button";
import { useColors, useTypography } from "../../ui/theme";
import { LinkPullRequest } from "./LinkPullRequest";
import { CreatePullRequest } from "./CreatePullRequest";
import { LinkedPullRequestRow } from "./LinkedPullRequestRow";
import { pullRequestsRefreshing } from "@canopy/domain/github-pr";
import { useQueryRefresh } from "../../state/query-refresh";
import { ThreadPanelSection } from "../threads/ThreadPanelSection";

export function ThreadPullRequests({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { client, queries, online } = useSession();
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

  useEffect(() => {
    setExpanded(false);
    setOffset(0);
  }, [thread.id]);

  useEffect(() => {
    if (read.data && offset >= total && offset > 0) setOffset(0);
  }, [read.data, offset, total]);

  return (
    <ThreadPanelSection
      title="Pull requests"
      count={total}
      style={{ borderBottomWidth: 0 }}
      action={
        <View style={{ flexDirection: "row", height: 48 }}>
          <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
            <IconButton
              icon="link"
              label="Link pull request"
              size="sm"
              disabled={!online || read.data?.stale}
              onPress={() => setLinking(true)}
            />
          </View>
          <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
            {!read.data?.hasCurrentBranch && !links.some((link) => link.currentBranch) && (
              <IconButton
                icon="plus"
                label="Create pull request"
                size="sm"
                disabled={!online || read.data?.stale}
                onPress={() => setCreating(true)}
              />
            )}
          </View>
        </View>
      }
    >
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
        <PullRequestPagination offset={offset} total={total} nextOffset={read.data?.nextOffset} onPage={setOffset} />
      )}
      {total > 4 && (
        <Button
          variant="text"
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
          <Button title="Retry" variant="text" size="sm" onPress={() => void read.reload()} />
        </>
      )}
      <LinkPullRequest
        visible={linking}
        onClose={() => setLinking(false)}
        threadId={thread.id}
        revision={read.data?.revision ?? thread.pullRequestRevision}
        onlinked={(value) => {
          setOffset(0);
          queries.set(`ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}:0`, value);
        }}
      />
      <CreatePullRequest
        threadId={thread.id}
        visible={creating}
        onClose={() => setCreating(false)}
        oncreated={() => void read.reload()}
        ondrafted={onClose}
      />
    </ThreadPanelSection>
  );
}

function PullRequestPagination({
  offset,
  total,
  nextOffset,
  onPage,
}: {
  offset: number;
  total: number;
  nextOffset: number | undefined;
  onPage: (offset: number) => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Button
        variant="text"
        size="sm"
        title="Previous"
        disabled={!offset}
        onPress={() => onPage(Math.max(0, offset - 20))}
      />
      <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
        {offset + 1}–{Math.min(offset + 20, total)} of {total}
      </Text>
      <Button variant="text" size="sm" title="Next" disabled={!nextOffset} onPress={() => onPage(nextOffset ?? 0)} />
    </View>
  );
}
