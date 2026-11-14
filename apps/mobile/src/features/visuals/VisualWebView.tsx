import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { WebView, WebViewMessageEvent } from "react-native-webview";
import { base64Encode } from "@bufbuild/protobuf/wire";
import * as Crypto from "expo-crypto";
import type { ui } from "@canopy/contracts";
import { mountVisualShell, type ShellMount, type ShellMountResult } from "@canopy/domain/visual-shell";
import {
  clampVisualHeight,
  openShellEnvelope,
  shellEnvelope,
  VISUAL_LIMITS,
  VisualFrameInbox,
  type HostMessage,
  type VisualTheme,
} from "@canopy/domain/visuals";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { useReducedMotion } from "../../ui/motion";
import { SandboxedWebView } from "./SandboxedWebView";
import { loadVisualStates, savedVisualState, saveVisualState } from "./visual-state";

const randomToken = () => base64Encode(Crypto.getRandomBytes(18), "url");

function mount(response: ui.GetVisualResponse, theme: VisualTheme, reducedMotion: boolean): ShellMountResult {
  const visual = response.visual;

  if (!visual) return { kind: "invalid" };

  try {
    return mountVisualShell(response.specJson, {
      title: visual.title,
      kitVersion: visual.kitVersion,
      theme,
      reducedMotion,
      state: savedVisualState(visual.visualId, visual.version),
      random: randomToken,
    });
  } catch {
    return { kind: "invalid" };
  }
}

function send(web: WebView<object> | null, shell: ShellMount | undefined, message: HostMessage) {
  if (shell) web?.postMessage(shellEnvelope(shell.token, message));
}

/**
 * One live WebView for a loaded visual version (docs/agent-visuals.md §4). It loads a trusted shell around the same
 * sandboxed document and CSP as the web; the shell relays the frame's port messages to this host in a per-mount
 * token envelope, and this host parses, size-caps and rate-limits each one. The WebView has no file, content or
 * universal access, no cookies or storage, opens no windows and navigates nowhere after the first load.
 */
export function VisualWebView({
  response,
  theme,
  maxHeight,
  initialHeight,
  active,
  onHeight,
  onEscape,
  onRetry,
}: {
  response: ui.GetVisualResponse;
  theme: VisualTheme;
  maxHeight: number;
  /** The height reserved before the visual reports its own, so mounting doesn't move the timeline. */
  initialHeight: number;
  active: boolean;
  onHeight?: (height: number) => void;
  onEscape?: () => void;
  onRetry: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const web = useRef<WebView<object>>(null);
  const [states, setStates] = useState(false);
  const [failure, setFailure] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(() => clampVisualHeight(initialHeight, maxHeight));
  const frame = useRef(0);
  // The first appearance is compiled in; later changes travel as host messages once the shell has loaded.
  const [initial] = useState(() => ({ theme, reducedMotion }));

  useEffect(() => {
    void loadVisualStates().then(() => setStates(true));
  }, []);

  // Compiled once per mount; Retry remounts with a fresh nonce, instance and token.
  const mounted = useMemo(
    () => (states ? mount(response, initial.theme, initial.reducedMotion) : undefined),
    [response, states, initial],
  );

  const shell = mounted?.kind === "ready" ? mounted : undefined;
  const inbox = useMemo(() => (shell ? new VisualFrameInbox(shell.domains) : undefined), [shell]);

  const ready = loaded ? shell : undefined;

  useEffect(() => send(web.current, ready, { type: "theme", theme }), [ready, theme]);
  useEffect(() => send(web.current, ready, { type: "reduced_motion", reduced: reducedMotion }), [ready, reducedMotion]);
  useEffect(() => send(web.current, ready, { type: "visibility", visible: active }), [ready, active]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function onMessage(event: WebViewMessageEvent) {
    const relayed = shell && openShellEnvelope(event.nativeEvent.data, shell.token);
    const message = relayed !== undefined && inbox?.receive(relayed, Date.now());
    const visual = response.visual;

    if (!message || !visual) return;

    switch (message.type) {
      case "ready":
      case "height": {
        const next = clampVisualHeight(message.height, maxHeight);
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          setHeight(next);
          onHeight?.(next);
        });

        return;
      }

      case "local_state":
        saveVisualState(visual.visualId, visual.version, message.state);

        return;
      case "render_error":
        setFailure("Couldn't open this visual.");

        return;
      case "escape":
        onEscape?.();

        return;
    }
  }

  if (failure || (mounted && !shell))
    return (
      <VisualProblem
        text={
          failure || (mounted?.kind === "update" ? "Update Canopy to open this visual." : "Couldn't open this visual.")
        }
        onRetry={mounted?.kind === "update" ? undefined : onRetry}
      />
    );

  if (!shell) return <View style={{ height }} />;

  return (
    <SandboxedWebView
      key={shell.token}
      ref={web}
      html={shell.html}
      height={height}
      loaded={loaded}
      onLoaded={() => setLoaded(true)}
      onMessage={onMessage}
      onFailure={() => setFailure("Couldn't open this visual.")}
    />
  );
}

function VisualProblem({ text, onRetry }: { text: string; onRetry: (() => void) | undefined }) {
  const c = useColors();

  return (
    <View
      style={{
        minHeight: VISUAL_LIMITS.minHeight,
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 16,
      }}
    >
      <Text accessibilityRole="alert" style={[styles.body, { textAlign: "center", color: c.soft }]}>
        {text}
      </Text>
      {onRetry ? <Button variant="secondary" size="sm" title="Retry" onPress={onRetry} /> : null}
    </View>
  );
}
