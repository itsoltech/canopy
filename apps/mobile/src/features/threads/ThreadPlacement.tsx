import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { placementPath } from "@canopy/domain/git-heads";
import { PickerSheet } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { openSettingsSection } from "../settings/navigation";
import { ThreadBranch } from "./ThreadBranch";
import { useOverview } from "../../state/overview";
import { ThreadPanelLine } from "./ThreadPanelLine";

/** The working directory on one line: a worktree by its name, a directory with its leading part shortened. */
function Location({ thread, home, onClose }: { thread: ui.Thread; home?: string; onClose: () => void }) {
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const worktree = thread.worktree;
  const shown = placementPath(thread.cwd, home);
  const title = worktree ? "Worktree" : "Directory";

  return (
    <>
      <ThreadPanelLine
        icon="folder"
        trailing="ellipsis-horizontal"
        label={`${title} ${thread.cwd}`}
        hint="Shows actions"
        onPress={() => setOpen(true)}
        value={
          worktree ? (
            <Text numberOfLines={1} ellipsizeMode="middle" style={[type.mono, { color: c.text, fontWeight: "600" }]}>
              {shown.name}
            </Text>
          ) : (
            <Text numberOfLines={1} ellipsizeMode="head" style={[type.mono, { color: c.muted }]}>
              {shown.parent}
              <Text style={{ color: c.text, fontWeight: "600" }}>{shown.name}</Text>
            </Text>
          )
        }
      />
      <PickerSheet
        title={title}
        note={thread.cwd}
        visible={open}
        onClose={() => setOpen(false)}
        sections={[
          {
            options: [
              { value: "copy", label: "Copy path" },
              ...(worktree ? [{ value: "manage", label: "Manage worktree" }] : []),
            ],
          },
        ]}
        onSelect={(value) => {
          setOpen(false);

          if (value === "copy")
            void Clipboard.setStringAsync(thread.cwd)
              .then(() => toast(`${title} path copied`))
              .catch(() => toast("Could not copy the path. Try again."));
          else if (worktree) {
            onClose();
            openSettingsSection("worktrees", {
              projectId: thread.projectId,
              workerId: thread.workerId,
              worktreeId: worktree.id,
            });
          }
        }}
      />
    </>
  );
}

export function ThreadPlacement({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { workers } = useOverview();
  const worker = workers.find((worker) => worker.id === thread.workerId);
  const head = thread.worktree ?? thread.checkoutHead;

  return (
    <View>
      <Location thread={thread} home={worker?.homeDirectory} onClose={onClose} />
      {head && <ThreadBranch thread={thread} worker={worker} />}
    </View>
  );
}
