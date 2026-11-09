import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GitRef, ui } from "@canopy/contracts";
import { branchSwitchReason, headLabel } from "@canopy/domain/git-heads";
import { nodeRef } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { PickerSheet } from "../../ui/Picker";
import { styles, useColors, useTypography } from "../../ui/theme";

export function ThreadBranch({ thread, worker }: { thread: ui.Thread; worker?: ui.Worker }) {
  const { computers } = useOverview();
  const { online } = useSession();
  const home = computers.find((home) => home.nodeId === thread.nodeId || nodeRef(home.nodeId) === thread.nodeId);
  const reason = branchSwitchReason(thread, worker, home) || (!online ? "Reconnect to switch branches." : "");

  return <ThreadBranchPicker key={`${thread.id}:${reason}`} thread={thread} reason={reason} />;
}

function ThreadBranchPicker({ thread, reason }: { thread: ui.Thread; reason: string }) {
  const c = useColors();
  const type = useTypography();
  const { client } = useSession();
  const head = thread.worktree ?? thread.checkoutHead;
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose() {
    if (!client || reason || busy) return;
    setBusy(true);
    setError("");

    try {
      const result = await client.api.listThreadBranches({ threadId: thread.id }, { timeoutMs: 35_000 });

      if (!result.supported) {
        setError(result.detail || "This directory is not a git checkout.");

        return;
      }

      setRefs(result.refs?.refs ?? []);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list branches. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function select(value: string) {
    const ref = refs.find((ref) => `${ref.remote ? "remote" : "local"}:${ref.name}` === value);

    if (!client || !ref || reason || busy) return;
    setBusy(true);
    setError("");

    try {
      await client.api.switchThreadBranch(
        { threadId: thread.id, branch: ref.name, remote: ref.remote },
        { timeoutMs: 130_000 },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch branches. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Switch branch"
        accessibilityHint={reason || undefined}
        disabled={Boolean(reason) || busy}
        onPress={() => void choose()}
        style={{ minHeight: 128, flexDirection: "row", gap: 8 }}
      >
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={[styles.meta, { color: c.muted }]}>Branch</Text>
          <Text selectable style={[type.mono, { color: c.text }]}>
            {head ? headLabel(head) : "Unknown branch"}
          </Text>
          {thread.worktree?.baseRef ? (
            <Text style={[styles.meta, { color: c.muted }]}>from {thread.worktree.baseRef}</Text>
          ) : null}
        </View>
        <Icon name={busy ? "arrow-path" : "chevron-down"} />
      </Pressable>
      {reason ? <Text style={[styles.meta, { color: c.muted }]}>{reason}</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>
          {error}
        </Text>
      ) : null}
      <PickerSheet
        title="Switch branch"
        visible={open && !reason}
        onClose={() => setOpen(false)}
        search="Search branches…"
        value={head && !head.detachedCommit ? `local:${head.branch}` : undefined}
        sections={[false, true].map((remote) => ({
          title: remote ? "Remote branches" : "Local branches",
          options: refs
            .filter((ref) => ref.remote === remote)
            .map((ref) => ({
              value: `${remote ? "remote" : "local"}:${ref.name}`,
              label: ref.name,
              wrapLabel: true,
              icon: "git-fork",
              disabled: !remote && ref.name === head?.branch && !head.detachedCommit,
            })),
        }))}
        onSelect={(value) => void select(value)}
      />
    </View>
  );
}
