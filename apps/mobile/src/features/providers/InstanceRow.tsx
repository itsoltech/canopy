import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  instanceName,
  statusAcross,
  statusOn,
  versionsOf,
  type InstanceStatus,
} from "@canopy/domain/provider-instances";
import { StatusDot } from "../../ui/Badge";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Switch } from "../../ui/Switch";
import { font, styles, useColors } from "../../ui/theme";

/** The harness mark with the instance's accent beneath it (web: InstanceMark). */
export function InstanceMark({ instance }: { instance: ui.ProviderInstance }) {
  const c = useColors();

  return (
    <View
      accessible={false}
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.well,
        borderWidth: instance.accentColor ? 2 : 0,
        borderColor: instance.accentColor || "transparent",
      }}
    >
      <ProviderIcon provider={instance.harness} size={16} />
    </View>
  );
}

/** A status dot and its words (web: StatusLine). */
export function StatusLine({ status }: { status: InstanceStatus }) {
  const c = useColors();

  return (
    <View style={[styles.row, { gap: 6, minWidth: 0 }]}>
      <StatusDot tone={status.tone} />
      <Text numberOfLines={1} style={[styles.workMeta, { flexShrink: 1, color: c.muted }]}>
        {status.label}
      </Text>
    </View>
  );
}

/**
 * One instance in the list (web: InstanceRow): mark, name, version and status; the switch turns it on or off on the
 * scope's worker, or assigns it to all workers. The row opens the instance's detail.
 */
export function InstanceRow({
  instance,
  worker,
  busy,
  disabled,
  onSelect,
  onToggle,
}: {
  instance: ui.ProviderInstance;
  worker: ui.Worker | undefined;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const c = useColors();
  const on = worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined;
  const status = worker ? statusOn(on, worker.online) : statusAcross(instance);
  const version = versionsOf(instance, worker?.id);
  const enabled = worker ? (on?.enabled ?? false) : instance.allWorkers || instance.workers.some((w) => w.enabled);
  const name = instanceName(instance);

  return (
    <View style={[styles.row, { minHeight: 52, gap: 10 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${status.label}`}
        accessibilityHint="Opens the instance"
        onPress={onSelect}
        style={({ pressed }) => [styles.row, { flex: 1, minWidth: 0, gap: 10, opacity: pressed ? 0.7 : 1 }]}
      >
        <InstanceMark instance={instance} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={[styles.row, { gap: 8, minWidth: 0 }]}>
            <Text numberOfLines={1} style={[styles.chrome, { flexShrink: 1, fontFamily: font.medium, color: c.text }]}>
              {name}
            </Text>
            {version ? (
              <Text
                numberOfLines={1}
                style={[styles.workMeta, { maxWidth: 88, fontVariant: ["tabular-nums"], color: c.muted }]}
              >
                {version}
              </Text>
            ) : null}
          </View>
          <StatusLine status={status} />
        </View>
      </Pressable>
      <Switch
        size="sm"
        label={`${name} on ${worker?.name ?? "all workers"}`}
        value={enabled}
        disabled={busy || disabled}
        onChange={onToggle}
      />
    </View>
  );
}
