import { useCallback, useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { useImage } from "./useImage";
import { VideoPoster } from "./VideoPoster";
import { openVideoStream } from "./video-stream";

export function NativeVideo({ file }: { file: ui.Attachment }) {
  const { client } = useSession();
  const c = useColors();
  const [uri, setUri] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const failed = useCallback(() => setError(true), []);

  useEffect(() => {
    const controller = new AbortController();
    setUri("");
    setError(false);

    if (client)
      void openVideoStream(client.api, file.id, controller.signal, () => setError(true))
        .then((stream) => {
          if (!controller.signal.aborted) setUri(stream.uri);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });

    return () => controller.abort();
  }, [client, file.id, retry]);

  return (
    <View style={{ gap: 12 }}>
      {uri && !error ? (
        <VideoSurface uri={uri} file={file} onError={failed} />
      ) : (
        <View style={{ height: 180 }}>
          <VideoPoster file={file} />
        </View>
      )}
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

function VideoSurface({ uri, file, onError }: { uri: string; file: ui.Attachment; onError: () => void }) {
  const [started, setStarted] = useState(false);

  const player = useVideoPlayer({ uri, contentType: "progressive", useCaching: false }, (value) => {
    value.muted = true;
    value.loop = false;
    value.staysActiveInBackground = false;
    value.showNowPlayingNotification = false;
    value.bufferOptions = { preferredForwardBufferDuration: 5 };
  });

  const poster = useImage({ kind: "attachment", file }, true, file.hasThumbnail);

  useFocusEffect(useCallback(() => () => player.pause(), [player]));
  useEffect(() => {
    const state = AppState.addEventListener("change", (value) => {
      if (value !== "active") player.pause();
    });

    const status = player.addListener("statusChange", (event) => {
      if (event.status === "error") onError();
    });

    const playing = player.addListener("playingChange", (event) => {
      if (event.isPlaying) setStarted(true);
    });

    return () => {
      state.remove();
      status.remove();
      playing.remove();
      player.pause();
    };
  }, [player, onError]);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ height: 220, borderRadius: 8, overflow: "hidden" }}>
        <VideoView
          player={player}
          nativeControls
          fullscreenOptions={{ enable: true }}
          allowsPictureInPicture={false}
          contentFit="contain"
          style={{ flex: 1 }}
        />
        {!started && poster.uri ? (
          <View pointerEvents="none" style={{ position: "absolute", inset: 0 }}>
            <VideoPoster file={file} />
          </View>
        ) : null}
      </View>
      {!started ? (
        <Button
          title="Play video"
          onPress={() => {
            setStarted(true);
            player.play();
          }}
        />
      ) : null}
    </View>
  );
}
