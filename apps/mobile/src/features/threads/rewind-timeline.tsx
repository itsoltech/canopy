import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { RewindHistory } from "./RewindHistory";
import type { useThreadRewind } from "./useThreadRewind";

/** The first loaded turn keeps the fold's stable list identity while its history is hidden. */
export function useRewindTimeline(turns: readonly ui.Turn[]) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const head = useMemo(() => {
    const groups = new Map<string, string>();

    for (const turn of turns) if (turn.rewindId && !groups.has(turn.rewindId)) groups.set(turn.rewindId, turn.id);

    return groups;
  }, [turns]);

  const shown = useMemo(
    () => turns.filter((turn) => !turn.rewindId || open.has(turn.rewindId) || head.get(turn.rewindId) === turn.id),
    [turns, open, head],
  );

  return {
    shown,
    open,
    head,
    toggle: (id: string) =>
      setOpen((before) => {
        const next = new Set(before);

        if (!next.delete(id)) next.add(id);

        return next;
      }),
  };
}

export function RewindGroup({
  turn,
  turns,
  rewind,
  actions,
  readOnly,
  children,
}: {
  turn: ui.Turn;
  turns: readonly ui.Turn[];
  rewind: ReturnType<typeof useRewindTimeline>;
  actions: ReturnType<typeof useThreadRewind>;
  readOnly: boolean;
  children: ReactNode;
}) {
  if (!turn.rewindId) return children;
  const open = rewind.open.has(turn.rewindId);

  return (
    <View>
      {rewind.head.get(turn.rewindId) === turn.id ? (
        <RewindHistory
          turns={turns}
          turn={turn}
          open={open}
          toggle={() => rewind.toggle(turn.rewindId)}
          actions={actions}
          readOnly={readOnly}
        />
      ) : null}
      {open ? children : null}
    </View>
  );
}
