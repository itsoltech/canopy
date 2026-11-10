import { useRef } from "react";
import { ui } from "@canopy/contracts";
import { PickerSheet, type PickerSection } from "../../../ui/Picker";

type Action = "edit" | "up" | "down" | "top" | "bottom" | "steer" | "queue";

/**
 * "…" of a queued message (web: QueueRowMenu): edit it, move it, and the composer's default while a turn runs —
 * queueing on (Send queues, holding it steers) or off (Send steers). The note says what the message runs with
 * instead of the thread's defaults; the row has no room for it. Edit opens once this sheet has closed.
 */
export function QueueMenu({
  turn,
  index,
  count,
  hints,
  delivery,
  disabled,
  onClose,
  onEdit,
  onMove,
  onDelivery,
}: {
  turn: ui.Turn | undefined;
  index: number;
  count: number;
  hints: readonly string[];
  delivery: ui.MessageDelivery;
  disabled: boolean;
  onClose: () => void;
  onEdit: (turn: ui.Turn) => void;
  onMove: (turn: ui.Turn, index: number) => void;
  onDelivery: (delivery: ui.MessageDelivery) => void;
}) {
  const pending = useRef<(() => void) | undefined>(undefined);
  const queues = delivery === ui.MessageDelivery.QUEUE;

  const sections: PickerSection<Action>[] = [
    { options: [{ value: "edit", label: "Edit message", icon: "pencil-square", disabled }] },
    {
      options: [
        { value: "up", label: "Move up", icon: "arrow-up", disabled: disabled || index <= 0 },
        { value: "down", label: "Move down", icon: "arrow-down", disabled: disabled || index >= count - 1 },
        { value: "top", label: "Move to top", icon: "arrow-up", disabled: disabled || index <= 0 },
        { value: "bottom", label: "Move to bottom", icon: "arrow-down", disabled: disabled || index >= count - 1 },
      ],
    },
    {
      options: [
        queues
          ? {
              value: "steer",
              label: "Turn off queueing",
              icon: "arrow-turn-down-right",
              description: "Send steers into the running turn. Hold Send to queue.",
            }
          : {
              value: "queue",
              label: "Turn on queueing",
              icon: "queue-list",
              description: "Send queues for the next turn. Hold Send to steer.",
            },
      ],
    },
  ];

  function run(action: Action) {
    if (!turn) return;

    if (action === "edit") pending.current = () => onEdit(turn);
    else if (action === "steer") onDelivery(ui.MessageDelivery.STEER);
    else if (action === "queue") onDelivery(ui.MessageDelivery.QUEUE);
    else onMove(turn, { up: index - 1, down: index + 1, top: 0, bottom: count - 1 }[action]);
  }

  return (
    <PickerSheet
      title="Queued message"
      visible={Boolean(turn)}
      onClose={onClose}
      onSelect={run}
      onDismiss={() => {
        const action = pending.current;
        pending.current = undefined;
        action?.();
      }}
      note={hints.length ? `Runs with ${hints.join(", ")}` : undefined}
      sections={sections}
    />
  );
}
