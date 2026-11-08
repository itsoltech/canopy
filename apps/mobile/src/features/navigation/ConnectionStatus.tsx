import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Tone } from "@canopy/domain/status-look";
import type { Connection } from "../../state/stream";
import { useOverview } from "../../state/overview";
import { Alert } from "../../ui/Alert";
import { StatusDot } from "../../ui/Badge";
import { Swap } from "../../ui/MotionViews";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { font, useColors, useTypography } from "../../ui/theme";
import { ConnectionRoutes } from "./ConnectionRoutes";
import { useSession } from "../../state/session";
import { useRouteStatus } from "../../state/route-status";
import { hasTailscaleFailure } from "../../api/tailscale-hint";
import { OpenTailscale } from "./OpenTailscale";

export interface StreamState {
  readonly connection: Connection;
  readonly retry: () => void;
  readonly issue?: string | undefined;
  readonly detail?: string | undefined;
}

/** Web: ConnectionStatus. Starting, syncing and dropped streams all read as reconnecting. */
const looks: Record<Connection, { tone: Tone; label: string; description: string }> = {
  live: { tone: "emerald", label: "Connected", description: "Live updates are on." },
  connecting: { tone: "amber", label: "Reconnecting…", description: "Canopy is connecting to the gateway." },
  syncing: { tone: "amber", label: "Reconnecting…", description: "Canopy is catching up on changes." },
  reconnecting: {
    tone: "amber",
    label: "Reconnecting…",
    description: "The connection dropped. Canopy reconnects automatically.",
  },
  unavailable: {
    tone: "rose",
    label: "Gateway unavailable",
    description: "The gateway is not responding. Canopy shows the last known state and keeps retrying.",
  },
  error: {
    tone: "rose",
    label: "Gateway unavailable",
    description: "The gateway refused the connection. Retry, or pair this phone again.",
  },
  offline: {
    tone: "neutral",
    label: "Offline",
    description: "This phone has no network. Canopy reconnects when it returns.",
  },
  paused: { tone: "neutral", label: "Paused", description: "Updates resume when Canopy is in the foreground." },
};

const tailscaleLook = {
  tone: "amber",
  label: "Check Tailscale",
  description: "Tailscale on this phone may be off or stuck. Turn it off and on in the Tailscale app, then reconnect.",
} as const;

function useConnectionLook(connection: Connection) {
  const tailscale = hasTailscaleFailure(useRouteStatus());

  return tailscale && ["connecting", "reconnecting", "unavailable"].includes(connection)
    ? tailscaleLook
    : looks[connection];
}

/** The gateway connection in the sidebar footer: a dot and a word. A tap shows what happened and a retry. */
export function ConnectionStatus({ stream }: { stream: StreamState }) {
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const look = useConnectionLook(stream.connection);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${look.label}. Show connection details`}
        accessibilityLiveRegion="polite"
        onPress={() => setOpen(true)}
        hitSlop={{ top: 12, bottom: 12 }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
          backgroundColor: pressed ? c.pressed : "transparent",
        })}
      >
        <StatusDot
          tone={look.tone}
          active={stream.connection === "reconnecting" || stream.connection === "connecting"}
        />
        {/* A new state swaps in beside its dot (web `swap`). */}
        <Swap value={look.label} style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={[type.small, { color: c.muted }]}>
            {look.label}
          </Text>
        </Swap>
      </Pressable>
      <ConnectionDetails stream={stream} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The status sheet: the state in a sentence, the native code of the last failure and a manual retry. */
export function ConnectionDetails({
  stream,
  visible,
  onClose,
}: {
  stream: StreamState;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const look = useConnectionLook(stream.connection);
  const down = stream.connection !== "live" && stream.connection !== "paused" && stream.connection !== "offline";
  const { reconnect } = useSession();

  return (
    <Overlay visible={visible} onClose={onClose} label="Connection">
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 12, flexShrink: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <StatusDot tone={look.tone} active={stream.connection === "reconnecting"} />
          <Text accessibilityRole="header" style={[type.body, { fontFamily: font.semibold, color: c.text }]}>
            {look.label}
          </Text>
        </View>
        <Text style={[type.small, { color: c.muted }]}>{stream.issue || look.description}</Text>
        {stream.detail && stream.connection !== "live" ? (
          <Text selectable style={[type.small, { color: c.muted }]}>
            Last error: <Text style={{ color: c.soft, fontVariant: ["tabular-nums"] }}>{stream.detail}</Text>
          </Text>
        ) : null}
        <ConnectionRoutes />
        {down && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
            {look === tailscaleLook && <OpenTailscale />}
            <Button
              title="Reconnect now"
              icon="arrow-path"
              size="sm"
              onPress={() => {
                reconnect();
                onClose();
              }}
            />
          </View>
        )}
      </View>
    </Overlay>
  );
}

/**
 * The strip under a screen header while live updates are not flowing (web: AppShell and the thread page). An
 * unresponsive gateway or a phone without network wins over a screen's own reconnect; a dropped screen stream shows
 * only when the gateway itself still answers. `Details` opens the status sheet with the native code.
 */
export function ConnectionBanner({ stream }: { stream?: StreamState }) {
  const overview = useOverview().stream;
  const tailscale = hasTailscaleFailure(useRouteStatus());
  const [open, setOpen] = useState(false);
  const shown = banner(overview, stream, tailscale);

  if (!shown) return null;

  return (
    <>
      <Alert
        banner
        tone={shown.tone}
        actions={
          <Button
            title={shown.action === "retry" ? "Retry" : "Details"}
            size="sm"
            variant="ghost"
            onPress={() => (shown.action === "retry" ? shown.stream.retry() : setOpen(true))}
          />
        }
      >
        {shown.text}
      </Alert>
      <ConnectionDetails stream={shown.stream} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function banner(overview: StreamState, stream: StreamState | undefined, tailscale: boolean) {
  if (overview.connection === "offline")
    return {
      tone: "warning",
      text: "You’re offline. Canopy reconnects when the network returns.",
      stream: overview,
      action: "details",
    } as const;

  if (tailscale && ["connecting", "reconnecting", "unavailable"].includes(overview.connection))
    return { tone: "warning", text: tailscaleLook.description, stream: overview, action: "details" } as const;

  if (overview.connection === "unavailable")
    return {
      tone: "warning",
      text: "The gateway is not responding. Showing the last known state; retrying automatically.",
      stream: overview,
      action: "details",
    } as const;

  if (stream?.connection === "error" && stream.issue)
    return { tone: "error", text: stream.issue, stream, action: "retry" } as const;

  if (stream && (stream.connection === "reconnecting" || stream.connection === "unavailable"))
    return { tone: "info", text: "Reconnecting to live updates…", stream, action: "details" } as const;

  return undefined;
}
