import { useRef, useState, type ComponentRef } from "react";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { PermissionMode, ui } from "@canopy/contracts";
import { modelDisplayName } from "@canopy/domain/model-name";
import { queuePreview } from "@canopy/domain/queue";
import { IconButton } from "../../../ui/components";
import { Icon } from "../../../ui/Icon";
import { AnchoredOverlay } from "../../../ui/AnchoredOverlay";
import { useMotion } from "../../../ui/motion";
import { styles, useColors } from "../../../ui/theme";
import { effortLabel } from "../../models/catalog";
import { permissionLabel } from "../permissions";
import { TrayPanel } from "./ComposerTray";
import { QueueMenu } from "./QueueMenu";
import { QueueSummary } from "./QueueSummary";
import { TRAY_ROW, TrayHeader, TrayIcon } from "./TrayHeader";
import type { Queue } from "./useQueue";

/** What the message runs with instead of the thread's defaults (web: `overrides`). */
export function overrides(turn: ui.Turn): string[] {
  return [
    turn.model ? modelDisplayName(turn.model) : "",
    turn.effort ? `${effortLabel(turn.effort)} effort` : "",
    turn.permissionMode !== PermissionMode.UNSPECIFIED ? permissionLabel(turn.permissionMode) : "",
  ].filter(Boolean);
}

/**
 * The queued messages above the tray (web: QueuePanel): one row per message in the order they run,
 * with Steer (into the running turn now), Delete and "…" (edit, move, the composer's default while a turn runs).
 * Rows rise in, leave and glide to a new place (`layout`).
 */
export function QueuePanel({
  queue,
  disabled,
  delivery,
  onDelivery,
  onEdit,
}: {
  queue: Queue;
  disabled: boolean;
  delivery: ui.MessageDelivery;
  onDelivery: (delivery: ui.MessageDelivery) => void;
  onEdit: (turn: ui.Turn) => void;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<ComponentRef<typeof View>>(null);
  const [menu, setMenu] = useState<string>();
  const { rise, layout } = useMotion();
  const expanded = open;
  const { rows } = queue;
  const label = `${rows.length} queued`;
  const selected = rows.find((t) => t.id === menu);

  if (!rows.length) return null;

  return (
    <TrayPanel>
      <AnchoredOverlay
        disclosure
        visible={expanded}
        onClose={() => setOpen(false)}
        label="Queued messages"
        triggerRef={triggerRef}
        anchor={
          <TrayHeader triggerRef={triggerRef} label={label} expanded={expanded} onPress={() => setOpen(!expanded)}>
            <TrayIcon name="queue-list" />
            <Text
              numberOfLines={1}
              style={[styles.meta, { flex: 1, minWidth: 0, color: c.soft, fontVariant: ["tabular-nums"] }]}
            >
              {label}
            </Text>
          </TrayHeader>
        }
      >
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
                onMore={() => {
                  setOpen(false);
                  setMenu(turn.id);
                }}
              />
            </Animated.View>
          ))}
        </View>
      </AnchoredOverlay>
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
  const preview = queuePreview(turn);

  return (
    <View style={[styles.row, { minHeight: TRAY_ROW, gap: 4, paddingLeft: 10, paddingRight: 2 }]}>
      <TrayIcon name="queue-list" />
      <View style={[styles.row, { flex: 1, minWidth: 0, gap: 4 }]}>
        {preview.text ? (
          <Text numberOfLines={1} style={[styles.meta, { flex: 1, minWidth: 0, color: c.soft }]}>
            {preview.text}
          </Text>
        ) : null}
        {preview.summary ? <QueueSummary preview={preview} /> : null}
      </View>
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
