import { Pressable, Text, View } from "react-native";
import { PermissionMode, Provider } from "@canopy/contracts";
import { statusLook, type StatusLook } from "@canopy/domain/status-look";
import type { IconName } from "@canopy/ui/icons";
import type { ReactNode } from "react";
import { StatusDot } from "../../../../ui/Badge";
import { Icon } from "../../../../ui/Icon";
import { ProviderIcon } from "../../../../ui/ProviderIcon";
import { font, styles, useColors } from "../../../../ui/theme";
import { useTone } from "../../../../ui/tone";
import { permissionLabel } from "../../../threads/permissions";
import { openThread, useTimelineDirectory } from "../../directory";

/** The white card with a violet ring that follows another thread live and opens it (web: SubagentCard, MessageDeliveryCard). */
function ThreadCard({
  threadId,
  icon,
  title,
  aside,
  children,
}: {
  threadId: string;
  icon: IconName;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const violet = useTone("violet");

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => openThread(threadId)}
      style={({ pressed }) => ({
        gap: 6,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: violet.badge.ring,
        backgroundColor: pressed ? violet.badge.background : c.surface,
      })}
    >
      <View style={styles.row}>
        <Icon name={icon} color={violet.dot} />
        <Text numberOfLines={1} style={[styles.body, { flex: 1, fontFamily: font.medium, color: c.text }]}>
          {title}
        </Text>
        {aside}
        <Icon name="chevron-right" color={c.faint} />
      </View>
      <View style={{ paddingLeft: 24, gap: 4 }}>{children}</View>
    </Pressable>
  );
}

function StatusText({ look }: { look: StatusLook }) {
  const c = useColors();

  return (
    <View style={[styles.row, { gap: 6, flexShrink: 1 }]}>
      <StatusDot tone={look.tone} />
      <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
        {look.label}
      </Text>
    </View>
  );
}

const providerOf = (name: string) =>
  name.startsWith("claude")
    ? Provider.CLAUDE
    : name.startsWith("codex")
      ? Provider.CODEX
      : name.startsWith("grok")
        ? Provider.GROK
        : undefined;

const MODES = new Map<string, PermissionMode>([
  ["read_only", PermissionMode.READ_ONLY],
  ["ask", PermissionMode.ASK],
  ["accept_edits", PermissionMode.ACCEPT_EDITS],
  ["full_auto", PermissionMode.FULL_AUTO],
]);

/** The bus names the mode in lower case ("full_auto"); an unknown one reads as unspecified (Ask first). */
const spawnedMode = (mode: string): PermissionMode => MODES.get(mode.toLowerCase()) ?? PermissionMode.UNSPECIFIED;

/**
 * A platform subagent started by spawn_thread (docs/agent-bus.md): the child thread's live status, what it runs on
 * and the start of its last message. `spawned`: what the call returned, for a thread the directory does not know.
 */
export function SubagentCard({
  threadId,
  title,
  spawned,
}: {
  threadId: string;
  title: string;
  spawned: { provider: string; model: string; effort: string; permissionMode: string };
}) {
  const c = useColors();
  const thread = useTimelineDirectory().thread(threadId);
  const look = thread ? statusLook(thread.status) : undefined;
  const provider = thread?.provider ?? providerOf(spawned.provider);

  const permission = thread
    ? permissionLabel(thread.permissionMode)
    : spawned.permissionMode
      ? permissionLabel(spawnedMode(spawned.permissionMode))
      : "";

  const settings = [thread?.effort || spawned.effort, permission].filter(Boolean);
  const result = thread?.lastMessage.trim() ?? "";

  return (
    <ThreadCard
      threadId={threadId}
      icon="sparkles"
      title={thread?.title || title}
      aside={look && <StatusText look={look} />}
    >
      <View style={[styles.row, { gap: 4 }]}>
        {provider !== undefined && <ProviderIcon provider={provider} />}
        <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.muted }]}>
          {[thread?.model || spawned.model || "Default model", ...settings].join(" · ")}
        </Text>
      </View>
      {result ? (
        <Text numberOfLines={3} style={[styles.body, { color: c.soft }]}>
          {result.replace(/[#*_`>]/g, "")}
        </Text>
      ) : (
        <Text style={[styles.body, { color: c.muted, fontStyle: "italic" }]}>
          {look?.active ? "Working on it…" : "No message yet"}
        </Text>
      )}
    </ThreadCard>
  );
}

/** A message sent with send_message: the target thread, how it went and the live status of the turn it reached. */
export function MessageDeliveryCard({
  callId,
  threadId,
  sentDelivery,
}: {
  callId: string;
  threadId: string;
  sentDelivery: string;
}) {
  const c = useColors();
  const directory = useTimelineDirectory();
  const target = directory.thread(threadId);
  const delivery = directory.delivery(callId);
  const how = delivery?.delivery || sentDelivery || "queue";
  const status = delivery?.status || "queued";

  const look: StatusLook =
    status === "steering" ? { label: "Steering into its turn…", tone: "sky", active: true } : statusLook(status);

  return (
    <ThreadCard threadId={threadId} icon="chat-bubble-left-right" title={target?.title || "Another thread"}>
      <View style={[styles.row, { gap: 6 }]}>
        <Text numberOfLines={1} style={[styles.meta, { flexShrink: 1, color: c.soft }]}>
          {how === "steer" ? "Steered into its running turn" : "Queued as its next turn"} ·
        </Text>
        <StatusText look={look} />
      </View>
    </ThreadCard>
  );
}
