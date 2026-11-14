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
      htmlDocument: visual.htmlDocument,
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

function useVisualStatesLoaded(): boolean {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadVisualStates().then(() => setLoaded(true));
  }, []);

  return loaded;
}

function useHtmlWatchdog(enabled: boolean, onFailure: (message: string) => void) {
  const lastResponse = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;
    lastResponse.current = Date.now();

    const watchdog = setInterval(() => {
      if (Date.now() - lastResponse.current > 10000) onFailure("This visual stopped responding.");
    }, 1000);

    return () => clearInterval(watchdog);
  }, [enabled, onFailure]);

  return lastResponse;
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
  const colors = useColors();
  const web = useRef<WebView<object>>(null);
  const states = useVisualStatesLoaded();
  const [failure, setFailure] = useState("");
  const [run, setRun] = useState(false);
  // Per mount token: a new shell starts unloaded, so its first about:blank is allowed again.
  const [loadedToken, setLoadedToken] = useState("");
  const [height, setHeight] = useState(() => clampVisualHeight(initialHeight, maxHeight));
  const frame = useRef(0);
  // The first appearance is compiled in; later changes travel as host messages once the shell has loaded.
  const [initial] = useState(() => ({ theme, reducedMotion }));

  // Compiled once per mount; Retry remounts with a fresh nonce, instance and token.
  const mounted = useMemo(
    () =>
      states && (!response.visual?.htmlDocument || run)
        ? mount(response, initial.theme, initial.reducedMotion)
        : undefined,
    [response, states, initial, run],
  );

  const shell = mounted?.kind === "ready" ? mounted : undefined;

  const inbox = useMemo(
    () => (shell ? new VisualFrameInbox(shell.domains, response.visual?.htmlDocument) : undefined),
    [shell, response.visual?.htmlDocument],
  );

  const lastResponse = useHtmlWatchdog(
    Boolean(shell && response.visual?.htmlDocument && active && !failure),
    setFailure,
  );

  const loaded = Boolean(shell) && loadedToken === shell?.token;
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
    lastResponse.current = Date.now();

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

  if (response.visual?.htmlDocument && !run)
    return (
      <VisualProblem
        text="Custom HTML from the agent. Don't enter passwords or secrets."
        onRetry={() => setRun(true)}
        actionLabel="Run"
      />
    );

  if (!shell) return <View style={{ height }} />;

  return (
    <View>
      {response.visual?.htmlDocument ? (
        <Text style={[styles.body, { padding: 12, color: colors.soft }]}>
          Custom HTML from the agent. Don't enter passwords or secrets.
        </Text>
      ) : null}
      <SandboxedWebView
        key={shell.token}
        ref={web}
        html={shell.html}
        height={height}
        loaded={loaded}
        onLoaded={() => setLoadedToken(shell.token)}
        onMessage={onMessage}
        onFailure={() => setFailure("Couldn't open this visual.")}
      />
    </View>
  );
}

function VisualProblem({
  text,
  onRetry,
  actionLabel = "Retry",
}: {
  text: string;
  onRetry: (() => void) | undefined;
  actionLabel?: string;
}) {
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
      {onRetry ? <Button variant="secondary" size="sm" title={actionLabel} onPress={onRetry} /> : null}
    </View>
  );
}
