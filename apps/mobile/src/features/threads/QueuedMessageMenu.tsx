import { useRef } from "react";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { PickerSheet, type PickerSection } from "../../ui/Picker";
import { toast } from "../../ui/Toast";
import { orderThreadTurns } from "@canopy/domain/history-pages";

type Action = "edit" | "up" | "down" | "top" | "bottom" | "steer" | "delete";

/** Only undispatched owner messages are reorderable. Platform turns retain their gateway positions. */
export function QueuedMessageMenu({
  threadId,
  turn,
  turns,
  running,
  disabled,
  onClose,
  onEdit,
  onError,
}: {
  threadId: string;
  turn?: ui.Turn;
  turns: readonly ui.Turn[];
  running: boolean;
  disabled: boolean;
  onClose: () => void;
  onEdit: (turn: ui.Turn) => void;
  onError: (message: string) => void;
}) {
  const { client } = useSession();
  const busy = useRef(false);
  const pending = useRef<(() => void) | undefined>(undefined);

  const queue = orderThreadTurns(
    turns.filter(
      (t) =>
        t.status === "queued" &&
        !t.dispatched &&
        !t.withdrawn &&
        !t.inherited &&
        t.trigger === "user" &&
        !t.sourceKind &&
        !t.sourceThreadId,
    ),
  );

  const index = queue.findIndex((t) => t.id === turn?.id);
  const unavailable = disabled || index < 0 || busy.current;

  const sections: PickerSection<Action>[] = [
    {
      options: [
        { value: "edit", label: "Edit message", icon: "pencil-square" },
        {
          value: "steer",
          label: "Steer now",
          icon: "arrow-up",
          disabled: !running,
        },
      ],
    },
    {
      options: [
        { value: "up", label: "Move up", icon: "arrow-up", disabled: index <= 0 },
        { value: "down", label: "Move down", icon: "arrow-down", disabled: index >= queue.length - 1 },
        { value: "top", label: "Move to top", icon: "arrow-up", disabled: index <= 0 },
        { value: "bottom", label: "Move to bottom", icon: "arrow-down", disabled: index >= queue.length - 1 },
      ],
    },
    { options: [{ value: "delete", label: "Delete message", icon: "trash", tone: "danger" }] },
  ];

  async function run(action: Action) {
    if (!client || !turn || unavailable) return;

    if (action === "edit") return onEdit(turn);
    busy.current = true;

    try {
      if (action === "delete") {
        await client.api.deleteQueuedTurn({ turnId: turn.id });
        toast("Queued message deleted", {
          label: "Undo",
          run: async () => {
            await client.api.restoreQueuedTurn({ turnId: turn.id });
          },
        });
      } else if (action === "steer") await client.api.steerQueuedTurn({ turnId: turn.id });
      else {
        const positions = { up: index - 1, down: index + 1, top: 0, bottom: queue.length - 1 };
        const ids = queue.map((t) => t.id);
        ids.splice(index, 1);
        ids.splice(Math.max(0, Math.min(positions[action], ids.length)), 0, turn.id);
        await client.api.reorderQueuedTurns({ threadId, turnIds: ids });
      }
    } catch {
      onError("Could not change the queue. Refresh the thread and retry.");
    } finally {
      busy.current = false;
    }
  }

  return (
    <PickerSheet
      title="Queued message"
      visible={Boolean(turn)}
      onClose={onClose}
      onSelect={(action) => {
        pending.current = () => void run(action);
      }}
      onDismiss={() => {
        const action = pending.current;
        pending.current = undefined;
        action?.();
      }}
      sections={sections.map((section) => ({
        ...section,
        options: section.options.map((option) => ({ ...option, disabled: unavailable || option.disabled })),
      }))}
    />
  );
}
