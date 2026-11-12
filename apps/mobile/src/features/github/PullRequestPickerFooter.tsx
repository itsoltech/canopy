import { useState } from "react";
import { Linking, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { LinkPullRequestUrl } from "./LinkPullRequestUrl";
import { ConnectGitHub } from "./ConnectGitHub";
import type { usePullRequestPicker } from "./usePullRequestPicker";

export function PullRequestPickerFooter({
  picker: p,
  threadId,
  revision,
  onlinked,
  directUrl,
}: {
  picker: ReturnType<typeof usePullRequestPicker>;
  threadId: string;
  revision: bigint;
  onlinked: (value: github.ThreadPullRequestsResponse) => void;
  directUrl: string;
}) {
  const c = useColors();
  const [manual, setManual] = useState(false);

  return (
    <View style={{ gap: 8, padding: 8 }}>
      {p.loading && !!p.data?.items.length && (
        <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
          Loading pull requests…
        </Text>
      )}
      {p.data?.state && p.data.state !== "ready" && (
        <>
          <Text style={[styles.overlayMeta, { color: c.muted }]}>{p.data.detail}</Text>
          {p.data.state === "account_required" && (
            <ConnectGitHub homeId={p.homeId} configured={p.data.configured} onconnected={p.reload} />
          )}
          {p.data.state === "installation_required" && (
            <Button
              size="sm"
              title="Manage access"
              disabled={!p.data.installUrl}
              onPress={() => {
                if (p.data?.installUrl) void Linking.openURL(p.data.installUrl);
              }}
            />
          )}
          {p.data.retryAt && (
            <Text style={[styles.overlayMeta, { color: c.muted }]}>
              Reset: {timestampDate(p.data.retryAt).toLocaleString()}
            </Text>
          )}
          {p.data.state !== "not_github" && <Button size="sm" title="Retry" onPress={p.reload} />}
        </>
      )}
      {!!p.error && (
        <>
          <Notice error>{p.error}</Notice>
          <Button title="Retry" onPress={p.reload} />
        </>
      )}
      {!!p.data?.nextCursor && (
        <Button
          variant="ghost"
          size="sm"
          title="Load more"
          disabled={p.loading || p.busy}
          onPress={() => void p.more()}
        />
      )}
      {manual || directUrl || p.data?.state === "not_github" ? (
        <LinkPullRequestUrl
          key={directUrl}
          initialUrl={directUrl}
          threadId={threadId}
          revision={revision}
          onlinked={(value) => {
            onlinked(value);
            p.reload();
          }}
        />
      ) : (
        <Button variant="ghost" size="sm" title="Link by URL" onPress={() => setManual(true)} />
      )}
    </View>
  );
}
