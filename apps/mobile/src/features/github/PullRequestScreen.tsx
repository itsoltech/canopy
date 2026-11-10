import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice, ScreenHeader } from "../../ui/components";
import { ScreenFrame, useContentPadding } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import { PullRequestSummary } from "./PullRequestSummary";

export function PullRequestScreen({ id }: { id: string }) {
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
    <ScreenFrame
      header={
        <ScreenHeader
          title={data?.summary?.ref ? `${data.summary.ref.repositoryName} #${data.summary.ref.number}` : "Pull request"}
        />
      }
    >
      <SummaryContent>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            size="sm"
            title={busy ? "Refreshing…" : "Refresh"}
            disabled={!online || busy}
            onPress={() => void refresh()}
          />
          {data?.summary?.ref && (
            <Button
              size="sm"
              title="Open on GitHub"
              onPress={() =>
                void Linking.openURL(
                  `https://github.com/${data.summary!.ref!.repositoryName}/pull/${data.summary!.ref!.number}`,
                ).catch(() => setError("Could not open GitHub. Check the link, then retry."))
              }
            />
          )}
        </View>
        <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
          Summary
        </Text>
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
