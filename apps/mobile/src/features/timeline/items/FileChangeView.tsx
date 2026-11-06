import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, type BlobRef, type FileChange } from "@canopy/contracts";
import type { Tone } from "@canopy/domain/status-look";
import { formatBytes } from "@canopy/domain/format";
import { basename } from "@canopy/domain/humanize";
import { diffCounts } from "@canopy/domain/tools";
import { Badge } from "../../../ui/Badge";
import { Diff } from "../../../ui/Diff";
import { styles, useColors, useTypography } from "../../../ui/theme";
import { useDevicePreferences } from "../../settings/device-preferences";
import { ItemFrame } from "../ItemFrame";
import { Aside, DiffCounts, RowTitle } from "./parts";
import { Chevron } from "../../../ui/MotionViews";

/** Files the agent added, edited, moved or deleted, each with its diff (web: FileChangeView). */
export function FileChangeView({ change, status }: { change: FileChange; status: ItemStatus }) {
  const verb = status === ItemStatus.IN_PROGRESS ? "Editing" : status === ItemStatus.DECLINED ? "Proposed" : "Edited";
  const names = change.changes.map((c) => basename(c.path)).join(", ") || "files";

  return (
    <ItemFrame
      icon="pencil-square"
      status={status}
      label={`${verb} ${names}`}
      title={<RowTitle lead={verb} subject={names} />}
      aside={
        <>
          <DiffCounts {...diffCounts(change.changes)} />
          {change.changes.length > 1 && <Aside>{change.changes.length} files</Aside>}
        </>
      }
    >
      {change.changes.map((entry, index) => (
        <FileDiffEntry key={index} {...entry} />
      ))}
    </ItemFrame>
  );
}

const KINDS = new Map<string, { label: string; tone: Tone }>([
  ["add", { label: "Added", tone: "emerald" }],
  ["update", { label: "Edited", tone: "sky" }],
  ["delete", { label: "Deleted", tone: "rose" }],
  ["move", { label: "Moved", tone: "violet" }],
]);

/** One changed file: what happened to it, its path, lines added and removed, and its diff (web: FileDiffEntry). */
function FileDiffEntry({
  path,
  kind,
  movePath,
  diff,
  diffBlob,
}: {
  path: string;
  kind: string;
  movePath: string;
  diff: string;
  diffBlob?: BlobRef | undefined;
}) {
  const c = useColors();
  const type = useTypography();
  const { values } = useDevicePreferences();
  const [expanded, setExpanded] = useState<boolean>();
  const shown = expanded ?? values.diffFileState === "expanded";
  const look = KINDS.get(kind) ?? { label: "Changed", tone: "neutral" as const };

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${shown ? "Collapse" : "Expand"} ${path}`}
        accessibilityState={{ expanded: shown }}
        onPress={() => setExpanded(!shown)}
        style={[styles.row, { minHeight: 40 }]}
      >
        <Chevron open={shown} color={c.faint} />
        <Badge tone={look.tone}>{look.label}</Badge>
        <Text numberOfLines={1} style={[type.mono, { flex: 1, fontSize: 12, color: c.text }]}>
          {path}
          {movePath ? ` → ${movePath}` : ""}
        </Text>
        {diff ? <DiffCounts {...diffCounts([{ diff }])} /> : null}
      </Pressable>
      {diff && shown ? (
        <Diff bare diff={diff} label={`Diff of ${path}`} />
      ) : diffBlob && shown ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Diff ({formatBytes(diffBlob.sizeBytes)}) is stored on the gateway; viewing it here is not supported yet.
        </Text>
      ) : null}
    </View>
  );
}
