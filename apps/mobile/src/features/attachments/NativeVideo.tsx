import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { VideoPoster } from "./VideoPoster";
import { VideoSurface } from "./VideoSurface";
import { openVideoStream } from "./video-stream";

export function NativeVideo({
  file,
  expanded,
  onExpandedChange,
}: {
  file: ui.Attachment;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { client } = useSession();
  const c = useColors();
  const { height } = useWindowDimensions();
  const frame = expanded ? layout.expanded : [layout.frame, { maxHeight: Math.max(164, height - 216) }];
  const [uri, setUri] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  const failed = useCallback(() => {
    setError(true);
    onExpandedChange(false);
  }, [onExpandedChange]);

  useEffect(() => {
    const controller = new AbortController();
    setUri("");
    setError(false);

    const streamFailed = () => {
      if (!controller.signal.aborted) failed();
    };

    if (client)
      void openVideoStream(client.api, file.id, controller.signal, streamFailed)
        .then((stream) => {
          if (!controller.signal.aborted) setUri(stream.uri);
        })
        .catch(streamFailed);

    return () => controller.abort();
  }, [client, failed, file.id, retry]);

  return (
    <View style={[layout.container, expanded && layout.expanded]}>
      <View style={frame}>
        {uri && !error ? (
          <VideoSurface
            key={uri}
            uri={uri}
            file={file}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            onError={failed}
          />
        ) : (
          <VideoPoster file={file} showPlay={false} />
        )}
      </View>
      {error ? (
        <>
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            Could not play this video. Retry or save the file to open it in another app.
          </Text>
          <Button title="Retry" onPress={() => setRetry((value) => value + 1)} />
        </>
      ) : !uri ? (
        <Text style={[styles.body, { color: c.muted }]}>Loading video…</Text>
      ) : null}
    </View>
  );
}

const layout = StyleSheet.create({
  container: { gap: 12 },
  expanded: { flex: 1 },
  frame: { aspectRatio: 16 / 9, minHeight: 164, borderRadius: 8, overflow: "hidden" },
});
