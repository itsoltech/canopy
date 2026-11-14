import { lazy, Suspense, useState } from "react";
import { Text, TurboModuleRegistry, useWindowDimensions, View } from "react-native";
import type { Visual } from "@canopy/contracts";
import { clampVisualHeight, VISUAL_LIMITS } from "@canopy/domain/visuals";
import { useAppActive } from "../../ui/active";
import { Button, IconButton } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { useViewportVisibility } from "../../ui/viewport";
import { VisualSummary } from "../timeline/items/VisualSummary";
import { VisualActions } from "./VisualActions";
import { useVisualLifecycle } from "./useVisualLifecycle";
import { useVisualTheme } from "./visual-theme";

/**
 * Builds without the WebView module (an older binary running a newer update) keep the text card. The module is
 * looked up before the renderer is ever imported, so its native component is never touched there.
 */
const webViewAvailable = TurboModuleRegistry.get("RNCWebViewModule") !== null;

const VisualWebView = lazy(() => import("./VisualWebView").then((module) => ({ default: module.VisualWebView })));

export function VisualView({ visual }: { visual: Visual }) {
  return webViewAvailable ? <InteractiveVisual visual={visual} /> : <VisualSummary visual={visual} />;
}

/**
 * An interactive visual in the reply (docs/agent-visuals.md). The timeline holds only its manifest: the spec is
 * read when the visual comes into view and the one WebView slot is free. Leaving the view pauses it at once and
 * releases the WebView after 5 s; a backgrounded app releases it at once. Its last height stays reserved.
 */
function InteractiveVisual({ visual }: { visual: Visual }) {
  const c = useColors();
  const type = useTypography();
  const theme = useVisualTheme();
  const window = useWindowDimensions();
  const viewport = useViewportVisibility();
  const appActive = useAppActive();
  const showing = viewport.visible && appActive;
  const [selected, setSelected] = useState(0);
  const [height, setHeight] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [actions, setActions] = useState(false);
  const version = selected || visual.version;

  const { live, response, failure, attempt, ready, open, claim, retry } = useVisualLifecycle({
    visual,
    version,
    showing,
    appActive,
    fullscreen,
  });

  const shown = response?.visual?.version === version ? response.visual : visual;

  const maxHeight = Math.min(
    VISUAL_LIMITS.maxHeight,
    Math.max(VISUAL_LIMITS.minHeight, Math.round(window.height * 0.7)),
  );

  const reserved = height || clampVisualHeight(visual.height || VISUAL_LIMITS.defaultHeight, maxHeight);

  function openFullscreen() {
    claim();
    setFullscreen(true);
  }

  // Inside the full-screen modal while it is open, so the sheet presents above it.
  const menu = (
    <VisualActions
      visual={visual}
      version={version}
      versions={response?.versions ?? [visual.version]}
      visible={actions}
      onClose={() => setActions(false)}
      onSelectVersion={setSelected}
    />
  );

  const webView = (full: boolean) =>
    ready ? (
      <Suspense fallback={<View style={{ height: full ? undefined : reserved }} />}>
        <VisualWebView
          key={`${full ? "full" : "inline"}:${ready.visual?.version}:${attempt}`}
          response={ready}
          theme={theme}
          maxHeight={full ? Math.max(VISUAL_LIMITS.minHeight, window.height - 120) : maxHeight}
          initialHeight={full ? VISUAL_LIMITS.defaultHeight : reserved}
          active={full || showing}
          {...(full ? { onEscape: () => setFullscreen(false) } : { onHeight: setHeight })}
          onRetry={retry}
        />
      </Suspense>
    ) : null;

  return (
    <View
      ref={viewport.ref}
      onLayout={viewport.onLayout}
      accessibilityLabel={`Visual: ${shown.title}`}
      style={{ overflow: "hidden", borderRadius: 12, borderWidth: 1, borderColor: c.ring, backgroundColor: c.surface }}
    >
      <VisualHeader
        title={shown.title}
        version={version}
        onFullscreen={openFullscreen}
        onActions={() => setActions(true)}
      />
      <View style={{ minHeight: reserved, justifyContent: "center" }}>
        {ready && !fullscreen ? (
          webView(false)
        ) : (
          <VisualPlaceholder
            text={failure || shown.description}
            state={fullscreen ? "fullscreen" : failure ? "failed" : live ? "loading" : "closed"}
            onOpen={open}
          />
        )}
      </View>
      {fullscreen ? (
        <FullScreenViewer
          title={shown.title}
          onClose={() => setFullscreen(false)}
          actions={<IconButton icon="ellipsis-horizontal" label="Visual actions" onPress={() => setActions(true)} />}
        >
          <View style={{ flex: 1 }}>
            {appActive && webView(true)}
            {!ready || !appActive ? (
              <Text style={[type.small, { padding: 16, color: c.muted }]}>{failure || "Loading visual…"}</Text>
            ) : null}
          </View>
          {menu}
        </FullScreenViewer>
      ) : (
        menu
      )}
    </View>
  );
}

function VisualHeader({
  title,
  version,
  onFullscreen,
  onActions,
}: {
  title: string;
  version: number;
  onFullscreen: () => void;
  onActions: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      style={[
        styles.row,
        { minHeight: 44, paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: c.rule },
      ]}
    >
      <Text
        numberOfLines={1}
        accessibilityRole="header"
        style={[type.body, { flex: 1, minWidth: 0, fontFamily: font.medium, color: c.text }]}
      >
        {title}
      </Text>
      <Text style={[type.small, { color: c.muted, fontVariant: ["tabular-nums"] }]}>Version {version}</Text>
      <IconButton icon="arrows-pointing-out" label="Open full screen" size="sm" onPress={onFullscreen} />
      <IconButton icon="ellipsis-horizontal" label="Visual actions" size="sm" onPress={onActions} />
    </View>
  );
}

/** What stands in the visual's reserved space while no WebView is live there. */
function VisualPlaceholder({
  text,
  state,
  onOpen,
}: {
  text: string;
  state: "fullscreen" | "failed" | "loading" | "closed";
  onOpen: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ alignItems: "center", gap: 12, padding: 16 }}>
      <Text numberOfLines={4} style={[type.body, { textAlign: "center", color: c.soft }]}>
        {text}
      </Text>
      {state === "fullscreen" ? (
        <Text style={[type.small, { color: c.muted }]}>Shown in full screen.</Text>
      ) : state === "loading" ? (
        <Text style={[type.small, { color: c.muted }]}>Loading visual…</Text>
      ) : (
        <Button variant="secondary" size="sm" title={state === "failed" ? "Retry" : "Open visual"} onPress={onOpen} />
      )}
    </View>
  );
}
