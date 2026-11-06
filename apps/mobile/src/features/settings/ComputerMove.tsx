import { useEffect, useState } from "react";
import type { ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { Button, Notice } from "../../ui/components";
import { useOverview } from "../../state/overview";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function ComputerMove({ nodeId }: { nodeId: string }) {
  const resource = useSettingsResource(`move:${nodeId}`, (api) => api.previewMove({ nodeId, everything: true }));
  const { projects } = useOverview();
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [moves, setMoves] = useState<ui.ComputerMove[]>([]);
  const data = resource.data;
  const projectIds = [...new Set(data?.items.flatMap((i) => (!i.blocked && i.projectId ? [i.projectId] : [])) ?? [])];

  const targets = projects.flatMap((p) =>
    p.workspaces.filter((w) => p.kind !== "scratch" && splitId(w.id).node === nodeRef(nodeId)),
  );

  const { run } = resource;
  const batch = moves[0]?.batchId;
  const running = moves.some((m) => !["done", "aborted"].includes(m.state));
  useEffect(() => {
    if (!batch || !running) return;

    const timer = setInterval(
      () =>
        void run((api) => api.getMoves({ batchId: batch })).then((r) => {
          if (r) setMoves(r.moves);
        }),
      2000,
    );

    return () => clearInterval(timer);
  }, [batch, running, run]);

  const ready =
    data && !data.unavailable && data.items.some((i) => !i.blocked) && projectIds.every((id) => placements[id]);

  return (
    <ResourceState resource={resource}>
      {data?.unavailable ? <Notice>{data.unavailable}</Notice> : null}
      <SettingsGroup title="Move preview">
        <SettingsSkeletonRows rows={3} />
        {data?.items.map((item) => (
          <SettingsValue
            key={item.id}
            title={item.title}
            value={item.blocked || item.moves.join(", ")}
            description={item.redo.length ? `Set up again: ${item.redo.join(", ")}` : undefined}
          />
        ))}
        {data && !data.items.length && <Notice>No threads or bots to move.</Notice>}
        {data?.shared.length ? <SettingsValue title="Stays shared" value={data.shared.join("\n")} /> : null}
        {data?.localOnly.length ? (
          <SettingsValue title="Stays on this computer" value={data.localOnly.join("\n")} />
        ) : null}
        {projectIds.map((id) => (
          <SettingChoice
            key={id}
            title={data?.items.find((i) => i.projectId === id)?.projectName || "Project workspace"}
            value={placements[id] || ""}
            options={[
              { value: "", label: "Choose workspace" },
              ...targets.map((w) => ({ value: w.id, label: w.label || w.rootPath })),
            ]}
            onChange={(value) => setPlacements({ ...placements, [id]: value })}
          />
        ))}
        <Button
          variant="primary"
          title="Move everything"
          disabled={!ready || resource.busy || moves.length > 0}
          onPress={() =>
            confirmAction(
              "Move everything",
              "Threads and bots move to the selected computer. Review the preview and workspace choices before continuing.",
              () =>
                void run((api) =>
                  api.startMove({
                    nodeId,
                    everything: true,
                    placements: projectIds.map((id) => ({ projectId: id, workspaceId: placements[id] })),
                  }),
                ).then((r) => {
                  if (r) setMoves(r.moves);
                }),
            )
          }
        />
        {moves.map((move) => (
          <SettingsValue
            key={move.id}
            title={move.title}
            value={move.state}
            description={move.error || move.redo.join(", ")}
          />
        ))}
      </SettingsGroup>
    </ResourceState>
  );
}
