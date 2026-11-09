import * as Clipboard from "expo-clipboard";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { headLabel, PROVISIONAL_BRANCH_HINT } from "@canopy/domain/git-heads";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { toast } from "../../ui/Toast";
import { openSettingsSection } from "../settings/navigation";

function CopyPath({ title, path }: { title: string; path: string }) {
  const c = useColors();

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
      <Text selectable style={[styles.body, { color: c.text }]}>
        {path}
      </Text>
    </View>
  );
}

export function ThreadPlacement({ thread, onClose }: { thread: ui.Thread; onClose: () => void }) {
  const c = useColors();
  const worktree = thread.worktree;
  const head = worktree ?? thread.checkoutHead;

  return (
    <View style={{ gap: 8 }}>
      <CopyPath title="Working directory" path={thread.cwd} />
      {head && (
        <Text selectable style={[styles.meta, { color: c.muted }]}>
          {headLabel(head)}
          {thread.worktree?.baseRef ? ` · from ${thread.worktree.baseRef}` : ""}
          {thread.worktree?.provisionalBranch ? `\n${PROVISIONAL_BRANCH_HINT}` : ""}
        </Text>
      )}
      {worktree && (
        <>
          <CopyPath title="Worktree path" path={worktree.path} />
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
        </>
      )}
    </View>
  );
}
