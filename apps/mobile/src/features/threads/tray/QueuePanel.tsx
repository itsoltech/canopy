import { useState } from "react";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { PermissionMode, ui } from "@canopy/contracts";
import { mentionLabel } from "@canopy/domain/mentions";
import { modelDisplayName } from "@canopy/domain/model-name";
import { messageOf } from "@canopy/domain/queue";
import { IconButton } from "../../../ui/components";
import { Icon } from "../../../ui/Icon";
import { Expand } from "../../../ui/MotionViews";
import { useMotion } from "../../../ui/motion";
import { styles, useColors } from "../../../ui/theme";
import { segmentsOf } from "../../composer/message-value";
import { effortLabel } from "../../models/catalog";
import { permissionLabel } from "../permissions";
import { TrayPanel } from "./ComposerTray";
import { QueueMenu } from "./QueueMenu";
import { TRAY_ROW, TrayHeader, TrayIcon } from "./TrayHeader";
import type { Queue } from "./useQueue";

/** The text a row shows: the message on one line, each chip (a file's badge, a mention) as its name. */
export const queuedText = (turn: ui.Turn): string =>
  (turn.messageText
    ? segmentsOf({ text: turn.messageText, mentions: turn.mentions })
        .map((segment) => (segment.mention ? mentionLabel(segment.mention) : segment.text))
        .join("")
    : messageOf(turn)
  )
    .replace(/\s+/g, " ")
    .trim();

/** What the message runs with instead of the thread's defaults, and what it carries (web: `overrides`). */
export function overrides(turn: ui.Turn): string[] {
  return [
    turn.model ? modelDisplayName(turn.model) : "",
    turn.effort ? `${effortLabel(turn.effort)} effort` : "",
    turn.permissionMode !== PermissionMode.UNSPECIFIED ? permissionLabel(turn.permissionMode) : "",
    turn.attachments.length ? (turn.attachments.length === 1 ? "1 file" : `${turn.attachments.length} files`) : "",
    turn.quotes.length ? (turn.quotes.length === 1 ? "1 quote" : `${turn.quotes.length} quotes`) : "",
  ].filter(Boolean);
}

/**
 * The queued messages in the tray (web: QueuePanel), open by default: one row per message in the order they run,
 * with Steer (into the running turn now), Delete and "…" (edit, move, the composer's default while a turn runs).
 * Rows rise in, leave and glide to a new place (`layout`).
 */
export function QueuePanel({
  queue,
  compact,
  disabled,
  delivery,
  onDelivery,
  onEdit,
}: {
  queue: Queue;
  compact: boolean;
  disabled: boolean;
  delivery: ui.MessageDelivery;
  onDelivery: (delivery: ui.MessageDelivery) => void;
  onEdit: (turn: ui.Turn) => void;
}) {
  const c = useColors();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<string>();
  const { rise, layout } = useMotion();
  const expanded = open && !compact;
  const { rows } = queue;
  const label = `${rows.length} queued`;
  const selected = rows.find((t) => t.id === menu);

  if (!rows.length) return null;

  return (
    <TrayPanel>
      <TrayHeader label={label} expanded={expanded} onPress={() => setOpen(!expanded)}>
        <TrayIcon name="queue-list" />
        <Text
          numberOfLines={1}
          style={[styles.meta, { flex: 1, minWidth: 0, color: c.soft, fontVariant: ["tabular-nums"] }]}
        >
          {label}
        </Text>
      </TrayHeader>
      <Expand open={expanded}>
        <View style={{ paddingBottom: 4 }}>
          {rows.map((turn) => (
            <Animated.View key={turn.id} entering={rise.entering} exiting={rise.exiting} layout={layout}>
              <QueueRow
                turn={turn}
                running={queue.running}
                fallback={Boolean(queue.fallback(turn.id))}
                disabled={disabled}
                onSteer={() => void queue.steer(turn)}
                onDelete={() => void queue.remove(turn)}
                onMore={() => setMenu(turn.id)}
              />
            </Animated.View>
          ))}
        </View>
      </Expand>
      <QueueMenu
        turn={selected}
        index={selected ? rows.indexOf(selected) : -1}
        count={rows.length}
        hints={selected ? overrides(selected) : []}
        delivery={delivery}
        disabled={disabled}
        onClose={() => setMenu(undefined)}
        onEdit={onEdit}
        onMove={(turn, index) => void queue.move(turn.id, index)}
        onDelivery={onDelivery}
      />
    </TrayPanel>
  );
}

function QueueRow({
  turn,
  running,
  fallback,
  disabled,
  onSteer,
  onDelete,
  onMore,
}: {
  turn: ui.Turn;
  running: boolean;
  fallback: boolean;
  disabled: boolean;
  onSteer: () => void;
  onDelete: () => void;
  onMore: () => void;
}) {
  const c = useColors();
  const text = queuedText(turn);

  return (
    <View style={[styles.row, { minHeight: TRAY_ROW, gap: 4, paddingLeft: 12, paddingRight: 4 }]}>
      <TrayIcon name="queue-list" />
      <Text numberOfLines={1} style={[styles.meta, { flex: 1, minWidth: 0, marginLeft: 4, color: c.soft }]}>
        {text || (turn.attachments.length > 0 ? "(only files)" : "(only quotes)")}
      </Text>
      {fallback ? (
        <Icon name="exclamation-circle" size={16} color={c.warning} label="Could not join the running turn" />
      ) : null}
      {running ? (
        <IconButton
          icon="arrow-turn-down-right"
          label="Steer into the running turn now"
          size="sm"
          disabled={disabled}
          onPress={onSteer}
        />
      ) : null}
      <IconButton icon="trash" label="Delete" size="sm" disabled={disabled} onPress={onDelete} />
      <IconButton icon="ellipsis-horizontal" label="More actions" size="sm" onPress={onMore} />
    </View>
  );
}
