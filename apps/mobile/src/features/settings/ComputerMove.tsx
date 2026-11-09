import { useEffect, useState } from "react";
import type { ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { router } from "expo-router";
import { Button, Notice } from "../../ui/components";
import { useOverview } from "../../state/overview";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export type MoveItem = { kind: "thread" | "bot"; id: string };

export function ComputerMove({
  nodeId,
  items,
  onOpened,
}: {
  nodeId: string;
  items?: MoveItem[];
  onOpened?: () => void;
}) {
  const everything = !items;
  const request = { nodeId, everything, items: items ?? [] };
  const resource = useSettingsResource(`move:${nodeId}:${JSON.stringify(items)}`, (api) => api.previewMove(request));
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
          title={everything ? "Move everything" : "Move"}
          disabled={!ready || resource.busy || moves.length > 0}
          onPress={() =>
            confirmAction(
              everything ? "Move everything" : "Move item",
              "Threads and bots move to the selected computer. Review the preview and workspace choices before continuing.",
              () =>
                void run((api) =>
                  api.startMove({
                    ...request,
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
        {!everything && !running && moves.length === 1 && moves[0]?.newId && moves[0].state === "done" && (
          <Button
            title="Open moved item"
            onPress={() => {
              const move = moves[0];

              if (!move?.newId) return;
              onOpened?.();
              router.replace({
                pathname: move.kind === "bot" ? "/bot/[id]" : "/thread/[id]",
                params: { id: move.newId },
              });
            }}
          />
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
