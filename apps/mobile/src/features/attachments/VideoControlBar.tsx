import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { videoClock, videoControlGlyphs, type VideoControlGlyph } from "@canopy/ui/video-controls";
import { styles } from "../../ui/theme";

export const videoInk = "#fafafa";
const videoAccent = "#34d399";

export type PlaybackGlyph = "play" | "pause" | "replay";

const playbackLabel: Record<PlaybackGlyph, string> = {
  play: "Play video",
  pause: "Pause video",
  replay: "Replay video",
};

export function VideoGlyph({ name, size = 20 }: { name: VideoControlGlyph; size?: number }) {
  const filled = name === "play" || name === "pause";

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? videoInk : "none"}
      stroke={filled ? "none" : videoInk}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      {videoControlGlyphs[name].map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

type ControlBarProps = {
  playback: PlaybackGlyph;
  time: number;
  duration: number;
  buffered: number;
  muted: boolean;
  expanded: boolean;
  captions?: boolean;
  onFocusChange: (focused: boolean) => void;
  onScrubbingChange: (scrubbing: boolean) => void;
  onTogglePlayback: () => void;
  onSeek: (seconds: number) => void;
  onToggleMute: () => void;
  onToggleExpanded: () => void;
  onToggleCaptions: () => void;
};

export function VideoControlBar({
  playback,
  time,
  duration,
  buffered,
  muted,
  expanded,
  captions,
  onFocusChange,
  onScrubbingChange,
  onTogglePlayback,
  onSeek,
  onToggleMute,
  onToggleExpanded,
  onToggleCaptions,
}: ControlBarProps) {
  const [scrubbing, setScrubbing] = useState<number>();
  const current = scrubbing ?? time;

  return (
    <View style={layout.bar}>
      <VideoSeekBar
        current={current}
        buffered={buffered}
        duration={duration}
        onPreview={(seconds) => {
          onScrubbingChange(seconds !== undefined);
          setScrubbing(seconds);
        }}
        onSeek={onSeek}
      />
      <View style={layout.row}>
        <VideoButton
          icon={playback}
          label={playbackLabel[playback]}
          onPress={onTogglePlayback}
          onFocusChange={onFocusChange}
        />
        <VideoButton
          icon={muted ? "muted" : "volume"}
          label={muted ? "Unmute video" : "Mute video"}
          onPress={onToggleMute}
          onFocusChange={onFocusChange}
        />
        <Text style={[styles.caption, layout.time]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
          {videoClock(current)} <Text style={layout.duration}>/ {videoClock(duration)}</Text>
        </Text>
        {captions !== undefined ? (
          <VideoButton
            icon="captions"
            label="Captions"
            active={captions}
            onPress={onToggleCaptions}
            onFocusChange={onFocusChange}
          />
        ) : null}
        <VideoButton
          icon={expanded ? "exit" : "enter"}
          label={expanded ? "Exit full screen" : "Open full screen"}
          onPress={onToggleExpanded}
          onFocusChange={onFocusChange}
        />
      </View>
    </View>
  );
}

function VideoButton({
  icon,
  label,
  active,
  onPress,
  onFocusChange,
}: {
  icon: VideoControlGlyph;
  label: string;
  active?: boolean;
  onPress: () => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      accessibilityRole={active === undefined ? "button" : "togglebutton"}
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { checked: active }}
      onFocus={() => {
        setFocused(true);
        onFocusChange(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange(false);
      }}
      onPress={onPress}
      style={({ pressed }) => [layout.button, pressed && layout.pressed, focused && layout.focused]}
    >
      <VideoGlyph name={icon} />
      {active ? <View style={layout.active} /> : null}
    </Pressable>
  );
}

function VideoSeekBar({
  current,
  buffered,
  duration,
  onPreview,
  onSeek,
}: {
  current: number;
  buffered: number;
  duration: number;
  onPreview: (seconds?: number) => void;
  onSeek: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const start = useRef(0);
  const enabled = Number.isFinite(duration) && duration > 0;
  const clamp = (seconds: number) => Math.min(duration, Math.max(0, seconds));
  const progress = enabled ? clamp(current) / duration : 0;
  const loaded = enabled ? clamp(buffered) / duration : 0;
  const secondsAt = (pageX: number) => clamp(((pageX - start.current - 7) / (width - 14)) * duration);

  return (
    <View
      accessible={enabled}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{
        min: 0,
        max: enabled ? Math.ceil(duration) : 0,
        now: enabled ? Math.floor(clamp(current)) : 0,
        text: `${videoClock(current)} of ${videoClock(duration)}`,
      }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={({ nativeEvent: { actionName } }) => {
        if (enabled && (actionName === "increment" || actionName === "decrement"))
          onSeek(clamp(current + (actionName === "increment" ? 5 : -5)));
      }}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      onStartShouldSetResponder={() => enabled && width > 14}
      onResponderGrant={({ nativeEvent: { pageX, locationX } }) => {
        start.current = pageX - locationX;
        onPreview(secondsAt(pageX));
      }}
      onResponderMove={({ nativeEvent: { pageX } }) => onPreview(secondsAt(pageX))}
      onResponderRelease={({ nativeEvent: { pageX } }) => {
        onSeek(secondsAt(pageX));
        onPreview(undefined);
      }}
      onResponderTerminate={() => onPreview(undefined)}
      style={layout.seek}
    >
      <View pointerEvents="none" style={layout.track}>
        <View style={[layout.buffered, { width: `${loaded * 100}%` }]} />
        <View style={[layout.played, { width: `${progress * 100}%` }]} />
        {enabled ? <View style={[layout.thumb, { left: `${progress * 100}%` }]} /> : null}
      </View>
    </View>
  );
}

const layout = StyleSheet.create({
  bar: {
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 4,
    backgroundImage: "linear-gradient(to top, rgba(9, 9, 11, 0.96), rgba(9, 9, 11, 0.8) 60%, rgba(9, 9, 11, 0))",
  },
  row: { flexDirection: "row", alignItems: "center" },
  button: {
    width: 44,
    height: 44,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: "#ffffff1f" },
  focused: { borderColor: videoAccent },
  active: { position: "absolute", bottom: 5, width: 16, height: 2, borderRadius: 1, backgroundColor: videoAccent },
  time: { flex: 1, fontVariant: ["tabular-nums"], color: videoInk, marginLeft: 6 },
  duration: { color: "#ffffffbf" },
  seek: { height: 38, justifyContent: "center" },
  track: { height: 4, borderRadius: 2, marginHorizontal: 7, backgroundColor: "#ffffff38" },
  buffered: { position: "absolute", height: 4, borderRadius: 2, backgroundColor: "#ffffff66" },
  played: { position: "absolute", height: 4, borderRadius: 2, backgroundColor: videoAccent },
  thumb: {
    position: "absolute",
    top: -5,
    marginLeft: -7,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: videoInk,
  },
});
