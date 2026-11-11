import { useState } from "react";
import { router } from "expo-router";
import { ScrollView, Text } from "react-native";
import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Notice, ScreenHeader, Segmented } from "../../ui/components";
import { ScreenFrame, useContentPadding } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { PullRequestSummary } from "./PullRequestSummary";
import { PullRequestHeader } from "./PullRequestHeader";

export function PullRequestScreen({ id, threadId }: { id: string; threadId?: string }) {
  const { client, queries, online } = useSession();
  const c = useColors();
  const key = `GetPullRequest:${id}`;
  const [denied, setDenied] = useState(false);

  const read = useSharedQuery<github.PullRequestSnapshot>(
    key,
    async () => {
      try {
        const value = await client!.api.getPullRequest({ pullRequestId: id });
        setDenied(false);

        return value;
      } catch (cause) {
        if (
          [Code.PermissionDenied, Code.NotFound, Code.FailedPrecondition, Code.Aborted].includes(
            ConnectError.from(cause).code,
          )
        )
          setDenied(true);
        throw cause;
      }
    },
    !!client,
    60_000,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = denied ? undefined : read.data;

  async function unlink() {
    if (!client || !threadId || busy) return;
    setBusy(true);

    try {
      const current = await client.api.listThreadPullRequests({ threadId });
      await client.api.unlinkThreadPullRequest({ threadId, pullRequestId: id, expectedRevision: current.revision });
      router.back();
    } catch {
      setError("Could not unlink this pull request. Refresh, then retry.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!client || busy) return;
    setBusy(true);
    setError("");

    try {
      queries.set(key, await client.api.refreshPullRequest({ pullRequestId: id }));
      setDenied(false);
    } catch (cause) {
      if (
        [Code.PermissionDenied, Code.NotFound, Code.FailedPrecondition, Code.Aborted].includes(
          ConnectError.from(cause).code,
        )
      )
        setDenied(true);
      setError("Could not load this summary. Check account access and the connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenFrame header={<ScreenHeader title="Pull request" />}>
      <SummaryContent>
        {data && (
          <PullRequestHeader
            snapshot={data}
            busy={busy || !online}
            onrefresh={() => void refresh()}
            onunlink={threadId ? () => void unlink() : undefined}
            onmessage={toast}
          />
        )}
        <Segmented
          options={[{ value: "summary", label: "Summary" }]}
          value="summary"
          onChange={() => {}}
          style={{ alignSelf: "flex-start" }}
        />
        {!!data?.detail && <Notice>{data.detail}</Notice>}
        {!!(error || read.error) && (
          <Notice error>{error || "Connect to load this page. Check account access, then retry."}</Notice>
        )}
        {data ? (
          <PullRequestSummary snapshot={data} />
        ) : (
          !read.error && <Text style={[styles.body, { color: c.muted }]}>Loading pull request…</Text>
        )}
      </SummaryContent>
    </ScreenFrame>
  );
}

function SummaryContent({ children }: { children: React.ReactNode }) {
  const padding = useContentPadding();

  return <ScrollView contentContainerStyle={{ ...padding, gap: 20 }}>{children}</ScrollView>;
}
