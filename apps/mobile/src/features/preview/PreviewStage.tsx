import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { useCopyText } from "../viewers/useCopyText";
import { PreviewCanvas } from "./PreviewCanvas";
import type { useAgentPreview } from "./useAgentPreview";

/** Loading, failure and live frames share one viewport; controls never depend on stream state. */
export function PreviewStage({
  preview,
  unavailable,
  allowed,
  failed,
  enabled,
  live,
  scope,
}: {
  preview: ReturnType<typeof useAgentPreview>;
  unavailable: boolean;
  allowed: boolean;
  failed: boolean;
  enabled: boolean;
  live: boolean;
  scope: string;
}) {
  const c = useColors();

  if (allowed && !failed) {
    return <PreviewCanvas key={scope} frame={preview.frame} uri={preview.uri} enabled={live} input={preview.input} />;
  }

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20, gap: 12 }}>
      {allowed ? (
        <PreviewFailure detail={preview.detail} retry={preview.retry} />
      ) : (
        <Text style={[styles.overlay, { color: c.muted }]}>
          {unavailable
            ? "Reconnect this computer and device to open a live preview."
            : !enabled
              ? "Allow agent access in Settings → Workers on web or desktop. Then reopen Preview."
              : "Check this tool in Settings → Workers on web or desktop. Then reopen Preview."}
        </Text>
      )}
    </ScrollView>
  );
}

function PreviewFailure({ detail, retry }: { detail: string; retry: () => void }) {
  const c = useColors();
  const [details, setDetails] = useState(false);
  const { copy } = useCopyText(detail);

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.overlay, { color: c.text }]}>Preview unavailable</Text>
      <Text style={[styles.overlay, { color: c.muted }]}>Check the connection and tool status, then retry.</Text>
      <Button title="Retry preview" onPress={retry} />
      {detail && (
        <Button
          title={details ? "Hide details" : "Show details"}
          variant="ghost"
          onPress={() => setDetails(!details)}
        />
      )}
      {details && (
        <>
          <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
            {detail}
          </Text>
          <Button title="Copy details" variant="ghost" onPress={() => void copy()} />
        </>
      )}
    </View>
  );
}

export function PreviewStatus({
  unavailable,
  allowed,
  failed,
  live,
  frame,
}: {
  unavailable: boolean;
  allowed: boolean;
  failed: boolean;
  live: boolean;
  frame: boolean;
}) {
  const c = useColors();

  const status = unavailable
    ? "Offline"
    : !allowed
      ? "Not ready"
      : failed
        ? "Disconnected"
        : live
          ? frame
            ? "Live"
            : "Waiting"
          : "Connecting…";

  return (
    <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
      {status}
    </Text>
  );
}
