import { useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatAge, formatBytes } from "@canopy/domain/format";
import { importRunActions, importRunLook } from "@canopy/domain/import-look";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/components";
import { ProgressBar } from "../../ui/ProgressBar";
import { useColors } from "../../ui/theme";
import { SettingsActions, SettingsGroup, settingsType } from "./SettingsGroup";
import { confirmAction, type useSettingsResource } from "./resource";
import { ImportRunDetails } from "./ImportRunDetails";

function counted(value: number, one: string): string {
  return `${value.toLocaleString("en")} ${value === 1 ? one : `${one}s`}`;
}

/** A run's counts, progress and gateway-authorized actions, including retrying a failed restore. */
export function ImportRunGroup({
  run,
  resource,
  style,
}: {
  run: ui.ImportRun;
  resource: ReturnType<typeof useSettingsResource<ui.ListImportRunsResponse>>;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const look = importRunLook(run.status);
  const actions = importRunActions(run);
  const [now] = useState(Date.now);
  const [details, setDetails] = useState(false);
  const date = run.createdAt && timestampDate(run.createdAt);

  const dateLabel =
    date && now - date.getTime() < 86400_000
      ? formatAge(run.createdAt, now)
      : date?.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });

  const title =
    [run.total > 0 && counted(run.total, "thread"), run.library.length > 0 && counted(run.library.length, "setting")]
      .filter(Boolean)
      .join(", ") || "Nothing";

  const summary = [
    `${run.done + actions.settingsDone} imported`,
    actions.failed > 0 && `${actions.failed} failed`,
    run.cancelled > 0 && `${run.cancelled} cancelled`,
    run.alreadyImported > 0 && `${run.alreadyImported} imported before`,
    run.bytesTotal > 0n && `${formatBytes(run.bytesDone)} of ${formatBytes(run.bytesTotal)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const act = (action: "cancel" | "resume" | "undo") =>
    void resource.run((api) =>
      action === "cancel"
        ? api.cancelImportRun({ runId: run.id })
        : action === "resume"
          ? api.resumeImportRun({ runId: run.id })
          : api.undoImportRun({ runId: run.id }),
    );

  return (
    <SettingsGroup
      style={style}
      title={`${run.workerName} · ${title}`}
      actions={
        <Badge tone={look.tone} dot>
          {look.label}
        </Badge>
      }
    >
      <View style={{ gap: 6 }}>
        {actions.active ? <ProgressBar done={run.bytesDone} total={run.bytesTotal} label="Import progress" /> : null}
        {dateLabel ? <Text style={[settingsType, { color: c.muted }]}>{dateLabel}</Text> : null}
        <Text style={[settingsType, { color: c.muted, fontVariant: ["tabular-nums"] }]}>{summary}</Text>
        {run.status === "running" && run.current ? (
          <Text style={[settingsType, { color: c.soft }]} numberOfLines={1}>{`Now: ${run.current}`}</Text>
        ) : null}
        {run.error ? <Text style={[settingsType, { color: c.warning }]}>{run.error}</Text> : null}
        {run.status === "undone" && actions.settingsDone > 0 ? (
          <Text style={[settingsType, { color: c.warning }]}>
            Some items could not be put back. Choose Remove imported items again.
          </Text>
        ) : null}
      </View>
      <Button size="sm" title={details ? "Hide details" : "Show details"} onPress={() => setDetails(!details)} />
      {details && <ImportRunDetails run={run} />}
      {actions.active || actions.retry || actions.removable ? (
        <SettingsActions>
          {actions.active ? (
            <Button size="sm" title="Cancel" busy={resource.busy} onPress={() => act("cancel")} />
          ) : null}
          {actions.retry ? (
            <Button
              size="sm"
              title={run.status === "paused" ? "Resume" : "Retry failed"}
              busy={resource.busy}
              onPress={() => act("resume")}
            />
          ) : null}
          {actions.removable ? (
            <Button
              size="sm"
              variant="ghost"
              title="Remove imported items"
              busy={resource.busy}
              onPress={() =>
                confirmAction(
                  "Remove imported items",
                  "Canopy removes threads this import created and restores settings and library items, except ones changed since. CLI files stay unchanged. You can import them again.",
                  () => act("undo"),
                )
              }
            />
          ) : null}
        </SettingsActions>
      ) : null}
    </SettingsGroup>
  );
}
