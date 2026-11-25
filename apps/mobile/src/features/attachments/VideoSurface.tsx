import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, AppState, Pressable, StyleSheet, View } from "react-native";
import { useEvent, useEventListener } from "expo";
import { useFocusEffect } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import type { ui } from "@canopy/contracts";
import { VIDEO_CONTROLS_IDLE_MS } from "@canopy/ui/video-controls";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { motion, useTween } from "../../ui/motion";
import { VideoControlBar, VideoGlyph, videoInk, type PlaybackGlyph } from "./VideoControlBar";
import { VideoPoster } from "./VideoPoster";

export function VideoSurface({
  uri,
  file,
  expanded,
  onExpandedChange,
  onError,
}: {
  uri: string;
  file: ui.Attachment;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onError: () => void;
}) {
  const video = useVideoPlayback(uri, (file.durationMs ?? 0) / 1000, onError);
  const controls = useVideoControls(video.isPlaying);
  const [firstFrame, setFirstFrame] = useState(false);

  function togglePlayback() {
    video.togglePlayback();
    controls.wake();
  }

  return (
    <View style={layout.frame}>
      <VideoView
        player={video.player}
        nativeControls={false}
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        surfaceType="textureView"
        contentFit="contain"
        onFirstFrameRender={() => setFirstFrame(true)}
        style={StyleSheet.absoluteFill}
      />
      {!firstFrame && file.hasThumbnail ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <VideoPoster file={file} showPlay={false} />
        </View>
      ) : null}
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={controls.shown ? togglePlayback : controls.wake}
        style={layout.surface}
      >
        {video.waiting ? (
          <View style={[layout.badge, layout.spinner]}>
            <ActivityIndicator color={videoInk} accessibilityLabel="Buffering video" />
          </View>
        ) : video.playback !== "pause" ? (
          <View style={layout.badge}>
            <VideoGlyph name={video.playback} size={28} />
          </View>
        ) : null}
      </Pressable>
      <Animated.View
        pointerEvents={controls.shown ? "box-none" : "none"}
        accessibilityElementsHidden={!controls.shown}
        importantForAccessibility={controls.shown ? "auto" : "no-hide-descendants"}
        style={[layout.overlay, controls.opacity]}
      >
        <VideoControlBar
          playback={video.playback}
          time={video.time}
          duration={video.duration}
          buffered={video.buffered}
          muted={video.muted}
          expanded={expanded}
          captions={video.captions}
          onFocusChange={controls.setFocused}
          onScrubbingChange={controls.setScrubbing}
          onTogglePlayback={togglePlayback}
          onSeek={(next) => {
            video.seek(next);
            controls.wake();
          }}
          onToggleMute={() => {
            video.player.muted = !video.player.muted;
            controls.wake();
          }}
          onToggleExpanded={() => {
            onExpandedChange(!expanded);
            controls.wake();
          }}
          onToggleCaptions={() => {
            video.toggleCaptions();
            controls.wake();
          }}
        />
      </Animated.View>
    </View>
  );
}

function useVideoPlayback(uri: string, fallbackDuration: number, onError: () => void) {
  const player = useVideoPlayer({ uri, contentType: "progressive", useCaching: false }, (value) => {
    value.muted = true;
    value.staysActiveInBackground = false;
    value.showNowPlayingNotification = false;
    value.bufferOptions = { preferredForwardBufferDuration: 5 };
    value.timeUpdateEventInterval = 0.2;
  });

  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  const { muted } = useEvent(player, "mutedChange", { muted: player.muted });
  const nativeDuration = useEvent(player, "sourceLoad")?.duration ?? player.duration;
  const duration = Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration : fallbackDuration;

  const { availableSubtitleTracks } = useEvent(player, "availableSubtitleTracksChange", {
    availableSubtitleTracks: player.availableSubtitleTracks,
  });

  const { subtitleTrack } = useEvent(player, "subtitleTrackChange", { subtitleTrack: player.subtitleTrack });
  const firstSubtitle = availableSubtitleTracks[0];
  const [playRequested, setPlayRequested] = useState(false);
  const [ended, setEnded] = useState(false);
  const [progress, setProgress] = useState({ time: 0, buffered: 0 });

  const pause = useCallback(() => {
    player.pause();
    setPlayRequested(false);
  }, [player]);

  useFocusEffect(useCallback(() => pause, [pause]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") pause();
    });

    return () => subscription.remove();
  }, [pause]);

  useEffect(() => {
    if (status === "error") onError();
  }, [status, onError]);

  useEventListener(player, "timeUpdate", ({ currentTime, bufferedPosition }) =>
    setProgress({ time: currentTime, buffered: bufferedPosition }),
  );

  useEventListener(player, "playToEnd", () => {
    pause();
    setEnded(true);
  });

  function togglePlayback() {
    if (playRequested) {
      pause();

      return;
    }

    setPlayRequested(true);

    if (ended) {
      setEnded(false);
      setProgress((value) => ({ ...value, time: 0 }));
      player.replay();
    } else player.play();
  }

  function seek(time: number) {
    player.currentTime = time;
    setProgress((value) => ({ ...value, time }));
    setEnded(false);
  }

  function toggleCaptions() {
    if (firstSubtitle) player.subtitleTrack = player.subtitleTrack ? null : firstSubtitle;
  }

  const playback: PlaybackGlyph = playRequested ? "pause" : ended ? "replay" : "play";

  return {
    player,
    isPlaying,
    playback,
    waiting: playRequested && status === "loading",
    time: ended && duration > 0 ? duration : progress.time,
    duration,
    buffered: progress.buffered,
    muted,
    captions: firstSubtitle ? Boolean(subtitleTrack) : undefined,
    togglePlayback,
    seek,
    toggleCaptions,
  };
}

function useVideoControls(isPlaying: boolean) {
  const [screenReader, setScreenReader] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [awake, setAwake] = useState(true);
  const [interaction, setInteraction] = useState(0);
  const keepVisible = !isPlaying || scrubbing || focused || screenReader;
  const shown = awake || keepVisible;
  const alpha = useTween(shown ? 1 : 0, { duration: motion.fast });
  const opacity = useAnimatedStyle(() => ({ opacity: alpha.get() }));

  useEffect(() => {
    let active = true;
    const reader = AccessibilityInfo.addEventListener("screenReaderChanged", setScreenReader);

    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (active) setScreenReader(enabled);
    });

    return () => {
      active = false;
      reader.remove();
    };
  }, []);

  useEffect(() => {
    if (keepVisible || !awake) return;

    const timeout = setTimeout(() => setAwake(false), VIDEO_CONTROLS_IDLE_MS);

    return () => clearTimeout(timeout);
  }, [awake, interaction, keepVisible]);

  function wake() {
    setAwake(true);
    setInteraction((value) => value + 1);
  }

  return { shown, opacity, wake, setScrubbing, setFocused };
}

const layout = StyleSheet.create({
  frame: { flex: 1, backgroundColor: "#09090b" },
  surface: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 24,
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "#ffffff29",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#09090bbd",
  },
  spinner: { width: 48, height: 48 },
  overlay: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
