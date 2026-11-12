import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
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
import { PullRequestCode } from "./PullRequestCode";
import { PullRequestTimeline } from "./PullRequestTimeline";
import { usePullRequestWatch } from "./usePullRequestWatch";
import { putContext } from "./context-draft";
import { CommentComposer } from "./CommentComposer";
import { invalidations } from "./invalidations";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
import { RepositoryAccessActions } from "./RepositoryAccessActions";

const deniedRead = (code: Code) =>
  [Code.PermissionDenied, Code.NotFound, Code.FailedPrecondition, Code.Aborted].includes(code);

const accountAccessError = (cause: unknown) => {
  const error = ConnectError.from(cause);

  return error.code === Code.PermissionDenied ? error.rawMessage : "";
};

export function PullRequestScreen({ id, threadId }: { id: string; threadId?: string }) {
  const { client, queries, online } = useSession();
  const key = `GetPullRequest:${id}`;
  const [denied, setDenied] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [tab, setTab] = useState("summary");

  const onUpdate = useCallback(
    (update: github.PullRequestUpdate) => {
      if (update.snapshot) queries.set(key, update.snapshot);
    },
    [queries, key],
  );

  usePullRequestWatch(id, onUpdate);

  const read = useSharedQuery<github.PullRequestSnapshot>(
    key,
    async () => {
      try {
        const value = await client!.api.getPullRequest({ pullRequestId: id });
        setDenied(false);
        setAccessError("");

        return value;
      } catch (cause) {
        setAccessError(accountAccessError(cause));

        if (deniedRead(ConnectError.from(cause).code)) setDenied(true);
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
      invalidations.publish(id);
      setDenied(false);
      setAccessError("");
    } catch (cause) {
      setAccessError(accountAccessError(cause));

      if (deniedRead(ConnectError.from(cause).code)) setDenied(true);
      setError("Could not load this summary. Check account access and the connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  const onMetadata = useEffectEvent(() => void refresh());
  useEffect(() => invalidations.subscribe(`${id}:metadata`, onMetadata), [id]);

  async function prepare(action: string) {
    if (!client || !threadId || busy) return;
    setBusy(true);

    try {
      const context = await client.api.preparePullRequestContext(
        { pullRequestId: id, threadId, action },
        { timeoutMs: 120_000 },
      );

      putContext(threadId, context);
      router.back();
    } catch {
      setError("Could not prepare PR context. Check access and attachment limits, then retry.");
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <View style={{ gap: 16 }}>
      {data && (
        <PullRequestHeader
          snapshot={data}
          busy={busy || !online}
          onrefresh={() => void refresh()}
          onunlink={threadId ? () => void unlink() : undefined}
          onmessage={toast}
          oncontext={threadId ? (action) => void prepare(action) : undefined}
        />
      )}
      <Segmented
        options={[
          { value: "summary", label: "Summary" },
          { value: "timeline", label: "Timeline" },
          { value: "code", label: "Code" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {!!data?.detail && <Notice>{data.detail}</Notice>}
      {!!(error || read.error) && (
        <Notice error>{accessError || error || "Connect to load this page. Check account access, then retry."}</Notice>
      )}
      {!!accessError && (
        <RepositoryAccessActions
          homeId={splitId(id).node ? `${GITHUB_HOME}~${splitId(id).node}` : ""}
          onconnected={() => void refresh()}
        />
      )}
    </View>
  );

  return (
    <ScreenFrame header={<ScreenHeader title="Pull request" />}>
      <PullRequestContent id={id} tab={tab} data={data} header={header} failed={!!read.error} />
    </ScreenFrame>
  );
}

function PullRequestContent({
  id,
  tab,
  data,
  header,
  failed,
}: {
  id: string;
  tab: string;
  data: github.PullRequestSnapshot | undefined;
  header: React.ReactNode;
  failed: boolean;
}) {
  const c = useColors();

  if (data && tab === "timeline")
    return <PullRequestTimeline key={data.accountId} id={id} snapshot={data} header={header} />;

  if (data && tab === "code") return <PullRequestCode key={data.accountId} snapshot={data} header={header} />;

  return (
    <SummaryContent>
      {header}
      {data ? (
        <View style={{ gap: 20 }}>
          <PullRequestSummary snapshot={data} />
          <CommentComposer key={`${data.accountId}:${id}`} snapshot={data} />
        </View>
      ) : (
        !failed && <Text style={[styles.body, { color: c.muted }]}>Loading pull request…</Text>
      )}
    </SummaryContent>
  );
}

function SummaryContent({ children }: { children: React.ReactNode }) {
  const padding = useContentPadding();

  return <ScrollView contentContainerStyle={{ ...padding, gap: 20 }}>{children}</ScrollView>;
}
