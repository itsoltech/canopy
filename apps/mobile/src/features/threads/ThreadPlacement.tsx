import * as Clipboard from "expo-clipboard";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { placementPath } from "@canopy/domain/git-heads";
import { Button } from "../../ui/components";
import { styles, useColors, useTypography } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { openSettingsSection } from "../settings/navigation";
import { ThreadBranch } from "./ThreadBranch";
import { useOverview } from "../../state/overview";

function CopyPath({ title, path, home }: { title: string; path: string; home?: string }) {
  const c = useColors();
  const type = useTypography();
  const shown = placementPath(path, home);

  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      <View style={styles.row}>
        <Text style={[styles.meta, { color: c.muted, flex: 1 }]}>{title}</Text>
        <Button
          title="Copy"
          size="sm"
          variant="ghost"
          onPress={() => {
            void Clipboard.setStringAsync(path)
              .then(() => toast(`${title} copied`))
              .catch(() => toast("Could not copy. Select the path to copy it."));
          }}
        />
      </View>
      <Text selectable style={[type.mono, { color: c.muted }]}>
        {shown.parent}
        <Text style={{ color: c.text, fontWeight: "600" }}>{shown.name}</Text>
      </Text>
    </View>
  );
}

export function ThreadPlacement({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const { workers } = useOverview();
  const worker = workers.find((worker) => worker.id === thread.workerId);
  const worktree = thread.worktree;
  const head = worktree ?? thread.checkoutHead;

  return (
    <View style={{ gap: 8 }}>
      <CopyPath title={worktree ? "Worktree" : "Directory"} path={thread.cwd} home={worker?.homeDirectory} />
      {head && <ThreadBranch thread={thread} worker={worker} />}
      {worktree && (
        <Button
          title="Manage worktree"
          onPress={() => {
            onClose();
            openSettingsSection("worktrees", {
              projectId: thread.projectId,
              workerId: thread.workerId,
              worktreeId: worktree.id,
            });
          }}
        />
      )}
    </View>
  );
}
