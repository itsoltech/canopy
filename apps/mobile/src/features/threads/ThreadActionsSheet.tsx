import { useRef, useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Field } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { PickerSheet, type PickerSection } from "../../ui/Picker";
import { useThreadActions, type ThreadAction } from "./useThreadActions";
import { ItemComputerMove } from "../settings/ItemComputerMove";
import type { SidebarMove } from "../navigation/sidebar-order";

type SheetAction = ThreadAction | "move" | "search" | SidebarMove;

function reorderOptions(enabled: boolean): PickerSection<SheetAction> {
  return {
    title: enabled ? "Move" : undefined,
    options: enabled
      ? [
          { value: "up", label: "Move up", icon: "arrow-up" },
          { value: "down", label: "Move down", icon: "arrow-down" },
          { value: "top", label: "Move to top", icon: "arrow-up" },
          { value: "bottom", label: "Move to bottom", icon: "arrow-down" },
        ]
      : [],
  };
}

interface ThreadActionsSheetProps {
  thread: ui.Thread;
  visible: boolean;
  onClose: () => void;
  onSideThread?: () => void;
  onGoal?: () => void;
  goalOpen?: boolean;
  onReorder?: ((direction: SidebarMove) => void) | undefined;
  onSearch?: (() => void) | undefined;
  readOnly?: boolean;
}

/** Shared by header and sidebar rows. The caller supplies only actions specific to the open screen. */
export function ThreadActionsSheet({
  thread,
  visible,
  onClose,
  onSideThread,
  onGoal,
  goalOpen,
  onReorder,
  onSearch,
  readOnly = false,
}: ThreadActionsSheetProps) {
  const state = useThreadActions(thread);
  const [rename, setRename] = useState(false);
  const [move, setMove] = useState(false);
  const [title, setTitle] = useState("");
  const pending = useRef<SheetAction | undefined>(undefined);
  const disabled = state.disabled || state.busy;

  const sections: PickerSection<SheetAction>[] = [
    { options: onSearch ? [{ value: "search", label: "Search thread", icon: "magnifying-glass" }] : [] },
    reorderOptions(!!onReorder),
    {
      options: [
        ...(onSideThread
          ? [
              {
                value: "side" as const,
                label: "New side thread",
                icon: "arrows-right-left" as const,
                disabled: state.archived,
              },
            ]
          : []),
        ...(onGoal
          ? [
              {
                value: "goal" as const,
                label: goalOpen ? "Replace goal" : "Set goal",
                icon: "flag" as const,
                disabled: state.archived,
              },
            ]
          : []),
      ],
    },
    {
      options: [
        { value: "pin", label: state.pinned ? "Unpin thread" : "Pin thread", icon: "star" },
        { value: "rename", label: "Rename thread", icon: "pencil-square", disabled: state.archived },
        ...(!thread.nodeId
          ? [{ value: "move" as const, label: "Move to a computer", icon: "arrows-right-left" as const }]
          : []),
        {
          value: "regenerate",
          label: "Regenerate title",
          icon: "arrow-path",
          disabled: state.archived || thread.titleGenerating || thread.lastSeq === 0n,
        },
        {
          value: "read",
          label: thread.markedUnread || thread.unseenResult ? "Mark as read" : "Mark as unread",
          icon: "chat-bubble-left",
        },
      ],
    },
    {
      options: [
        {
          value: "archive",
          label: state.archived
            ? thread.archivedBy === "cascade"
              ? "Unarchive with parent"
              : "Unarchive thread"
            : "Archive thread",
          icon: "archive-box",
        },
        { value: "delete", label: "Delete thread", icon: "trash", tone: "danger" },
      ],
    },
  ];

  return (
    <>
      <PickerSheet
        title="Thread actions"
        visible={visible}
        onClose={onClose}
        sections={sections.map((section) => ({
          ...section,
          options: section.options.map((option) => ({
            ...option,
            disabled: option.value === "search" ? false : readOnly || disabled || option.disabled,
          })),
        }))}
        onSelect={(action) => {
          pending.current = action;
        }}
        onDismiss={() => {
          const action = pending.current;
          pending.current = undefined;

          if (!action) return;

          if (action === "rename") {
            setTitle(thread.title);
            setRename(true);
          } else if (action === "search") onSearch?.();
          else if (action === "move") setMove(true);
          else if (action === "side") onSideThread?.();
          else if (action === "goal") onGoal?.();
          else if (action === "up" || action === "down" || action === "top" || action === "bottom") onReorder?.(action);
          else state.run(action);
        }}
      />
      <RenameThread state={state} visible={rename} title={title} setTitle={setTitle} onClose={() => setRename(false)} />
      {move && !state.disabled && (
        <ItemComputerMove item={{ kind: "thread", id: thread.id }} onClose={() => setMove(false)} />
      )}
    </>
  );
}

function RenameThread({
  state,
  visible,
  title,
  setTitle,
  onClose,
}: {
  state: ReturnType<typeof useThreadActions>;
  visible: boolean;
  title: string;
  setTitle: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <Overlay label="Rename thread" visible={visible && !state.disabled} onClose={onClose}>
      <View style={{ padding: 16, gap: 12 }}>
        <Field label="Title" value={title} onChangeText={setTitle} maxLength={500} autoFocus />
        <Button
          title="Rename thread"
          variant="primary"
          disabled={!title.trim()}
          busy={state.busy}
          onPress={() =>
            void state.rename(title.trim()).then((saved) => {
              if (saved) onClose();
            })
          }
        />
      </View>
    </Overlay>
  );
}
