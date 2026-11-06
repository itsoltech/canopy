import { useState } from "react";
import { Text, View } from "react-native";
import type { GitRef } from "@canopy/contracts";
import { headLabel, shortWorktreePath } from "@canopy/domain/git-heads";
import { PickerSheet } from "../../ui/Picker";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { ComposerPill } from "../threads/ComposerBox";
import type { WorkspaceChoice, WorkspaceDraft } from "./useWorkspaceDraft";

const choiceIcon = (choice: WorkspaceChoice) =>
  choice.kind === "checkout" ? "folder-open" : choice.kind === "new" ? "square-2-stack" : "git-fork";

const choiceLabel = (choice: WorkspaceChoice) =>
  choice.kind === "existing" ? headLabel(choice.worktree) : choice.kind === "new" ? "New worktree" : "Current checkout";

/**
 * The new thread's workspace pill and, next to it, the branch (docs/worktrees.md): the project's checkout, a new git
 * worktree from a base ref, or a previous worktree of this project on the chosen worker. Only where the worker
 * offers worktrees and the folder is a git repository.
 */
export function WorkspacePills({ draft }: { draft: WorkspaceDraft }) {
  const c = useColors();
  const [picker, setPicker] = useState<"workspace" | "ref" | null>(null);
  const close = () => setPicker(null);
  const choiceKey = (c: WorkspaceChoice) => (c.kind === "existing" ? c.worktree.id : c.kind);

  if (!draft.available) return null;

  return (
    <View style={[styles.row, { gap: 0, paddingHorizontal: 6, flexWrap: "wrap" }]}>
      <ComposerPill
        icon={choiceIcon(draft.choice)}
        title={choiceLabel(draft.choice)}
        onPress={() => {
          draft.refresh();
          setPicker("workspace");
        }}
      />
      {draft.choice.kind === "new" ? (
        <ComposerPill icon="git-fork" title={draft.branch || "Default branch"} onPress={() => setPicker("ref")} />
      ) : draft.branch ? (
        // The checkout's or the worktree's branch only shows: switching it here could change other threads' files.
        <View style={[styles.row, { gap: 4, minHeight: 36, paddingHorizontal: 6, flexShrink: 1 }]}>
          <Icon name="git-fork" size={14} color={c.muted} />
          <Text numberOfLines={1} style={[styles.meta, { color: c.muted, flexShrink: 1, fontFamily: "monospace" }]}>
            {draft.branch}
          </Text>
        </View>
      ) : null}
      <PickerSheet
        title="Workspace"
        visible={picker === "workspace"}
        onClose={close}
        search={draft.worktrees.length > 6 ? "Search worktrees" : undefined}
        value={choiceKey(draft.choice)}
        onSelect={(key) => {
          const worktree = draft.worktrees.find((w) => w.id === key);

          if (key === "checkout" || key === "new") draft.choose({ kind: key });
          else if (worktree) draft.choose({ kind: "existing", worktree });
        }}
        sections={[
          {
            title: draft.worktrees.length ? "Workspace" : undefined,
            options: [
              {
                value: "checkout",
                label: "Current checkout",
                description: "Works in the project's directory",
                icon: "folder-open",
              },
              {
                value: "new",
                label: "New worktree",
                description: "A new branch in its own directory",
                icon: "square-2-stack",
              },
            ],
          },
          ...[false, true].map((external) => ({
            title: external ? "Created outside Canopy" : "Managed by Canopy",
            options: draft.worktrees
              .filter((w) => w.external === external)
              .map((w) => ({
                value: w.id,
                label: headLabel(w),
                description: shortWorktreePath(w.path),
                keywords: w.path,
                badge: w.locked
                  ? "Locked"
                  : w.prunable
                    ? "Prunable"
                    : w.missing
                      ? "Missing"
                      : w.unavailableReason
                        ? "Unavailable"
                        : undefined,
                disabled: Boolean(w.unavailableReason),
                icon: "git-fork" as const,
              })),
          })),
        ]}
      />
      <RefPickerSheet visible={picker === "ref"} onClose={close} draft={draft} />
    </View>
  );
}

/** The base of a new worktree: local branches first (default, current), then remote ones. */
function RefPickerSheet({ visible, onClose, draft }: { visible: boolean; onClose: () => void; draft: WorkspaceDraft }) {
  const refs = draft.gitRefs;
  const priority = (ref: GitRef) => (ref.name === refs?.defaultBranch ? 0 : ref.name === refs?.currentBranch ? 1 : 2);
  const sorted = [...(refs?.refs ?? [])].sort((a, b) => priority(a) - priority(b));

  const option = (ref: GitRef) => ({
    value: ref.name,
    label: ref.name,
    icon: "git-fork" as const,
    badge:
      ref.name === refs?.defaultBranch
        ? "Default"
        : !ref.remote && ref.name === refs?.currentBranch
          ? "Current"
          : undefined,
  });

  return (
    <PickerSheet
      title="Base ref"
      visible={visible}
      onClose={onClose}
      search={sorted.length > 6 ? "Search refs" : undefined}
      value={draft.baseRef}
      onSelect={draft.chooseBase}
      sections={[
        { title: "Branches", options: sorted.filter((r) => !r.remote).map(option) },
        { title: "Remote branches", options: sorted.filter((r) => r.remote).map(option) },
      ]}
    />
  );
}
