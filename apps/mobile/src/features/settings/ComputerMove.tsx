import { useEffect, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { router } from "expo-router";
import { Button, Notice } from "../../ui/components";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { SettingsSkeletonRows } from "./SettingsSkeleton";
import { useAppActive } from "../../ui/active";

export type MoveItem = { kind: "thread" | "bot"; id: string };

/** Progress is a read: GetMoves only, never a mutation's refresh of the preview or the overview. */
function useMoveProgress(
  batch: string | undefined,
  moves: ui.ComputerMove[],
  setMoves: (moves: ui.ComputerMove[]) => void,
  reload: () => Promise<void>,
) {
  const { client } = useSession();
  const foreground = useAppActive();
  const running = moves.some((m) => !["done", "aborted"].includes(m.state));
  const watched = useRef(false);

  useEffect(() => {
    if (!batch || !running || !client || !foreground) return;
    let busy = false;
    let active = true;
    watched.current = true;

    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void client.api
        .getMoves({ batchId: batch })
        .then((r) => active && setMoves(r.moves))
        .catch(() => undefined)
        .finally(() => (busy = false));
    }, 2000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [batch, running, client, setMoves, foreground]);

  // A finished move changes what the preview shows; read it once.
  useEffect(() => {
    if (running || !watched.current) return;
    watched.current = false;
    void reload();
  }, [running, reload]);

  return running;
}

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

  const resource = useSettingsResource(`PreviewMove:${nodeId}:${JSON.stringify(items)}`, (api) =>
    api.previewMove(request),
  );

  const { projects } = useOverview();
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [moves, setMoves] = useState<ui.ComputerMove[]>([]);
  const data = resource.data;
  const projectIds = [...new Set(data?.items.flatMap((i) => (!i.blocked && i.projectId ? [i.projectId] : [])) ?? [])];

  const targets = projects.flatMap((p) =>
    p.workspaces.filter((w) => p.kind !== "scratch" && splitId(w.id).node === nodeRef(nodeId)),
  );

  const { run, reload } = resource;
  const batch = moves[0]?.batchId;
  const running = useMoveProgress(batch, moves, setMoves, reload);

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
