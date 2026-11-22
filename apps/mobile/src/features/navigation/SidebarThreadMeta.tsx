import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import type { ThreadRowPlace } from "@canopy/domain/git-heads";
import type { ThreadPullRequestBadge } from "@canopy/domain/github-pr";
import { threadRowMarks } from "@canopy/ui/thread-row";
import { Icon } from "../../ui/Icon";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { toneColor } from "../github/presentation";
import { useSidebarTypography } from "./sidebar-scale";
import { DraftMarker } from "../drafts/DraftMarker";

/**
 * The row's last line, as on web (docs/threads.md, "Wiersz wątku"): visible computer and place take at most 2/5, the live
 * branch the rest. Long branch names lose their middle, so the type prefix and the distinguishing end stay visible;
 * the row's accessibility label carries the full name. Linked pull requests show the newest one's state and number,
 * then `+N` for the others; grouped rows use compact state marks. The row's label carries PR details in words.
 */
export function SidebarThreadMeta({
  thread,
  worker,
  place,
  pullRequests,
  showWorker = true,
  groupedProject = false,
  groupedWorktree = false,
}: {
  thread: ui.Thread;
  worker?: ui.Worker;
  place: ThreadRowPlace;
  pullRequests?: ThreadPullRequestBadge | undefined;
  showWorker?: boolean;
  groupedProject?: boolean;
  groupedWorktree?: boolean;
}) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();
  const directory = groupedWorktree ? "" : place.place;
  const branch = groupedWorktree ? "" : place.branch;

  return (
    <View style={[styles.row, { gap: groupedProject ? 4 : 8 }]}>
      {showWorker && <Icon name="computer-desktop" size={16} color={worker?.online ? c.muted : c.faint} />}
      {(showWorker || directory) && (
        <Text
          numberOfLines={1}
          style={[
            type.meta,
            { minWidth: 0, color: c.muted },
            branch ? { flexShrink: 1, maxWidth: "40%" } : { flex: 1 },
          ]}
        >
          {showWorker ? (worker?.name ?? "Unknown worker") : ""}
          {showWorker && directory ? " · " : ""}
          {directory}
        </Text>
      )}
      {branch ? (
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name="git-fork" size={14} color={c.muted} />
          <Text numberOfLines={1} ellipsizeMode="middle" style={[type.meta, { flex: 1, minWidth: 0, color: c.muted }]}>
            {branch}
          </Text>
        </View>
      ) : null}
      <View style={[styles.row, { marginLeft: "auto", gap: groupedProject ? 4 : 8 }]}>
        <SidebarThreadMarks
          thread={thread}
          pullRequests={pullRequests}
          draft={groupedProject}
          compact={groupedProject}
        />
        <ProviderIcon provider={thread.provider} size={threadRowMarks.icon} opacity={threadRowMarks.providerOpacity} />
      </View>
    </View>
  );
}

/** Shared by the metadata line and the single-line worktree row. */
export function SidebarThreadMarks({
  thread,
  pullRequests,
  draft = false,
  compact = false,
}: {
  thread: ui.Thread;
  pullRequests?: ThreadPullRequestBadge | undefined;
  draft?: boolean;
  compact?: boolean;
}) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();

  return (
    <>
      {thread.goalStatus ? <Icon name="flag" size={16} /> : null}
      {pullRequests ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={pullRequests.look.icon} size={14} color={toneColor(c, pullRequests.look.tone)} />
          {!compact && (
            <Text numberOfLines={1} style={[type.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {pullRequests.number
                ? `#${pullRequests.number}${pullRequests.more ? ` +${pullRequests.more}` : ""}`
                : String(pullRequests.more)}
            </Text>
          )}
        </View>
      ) : null}
      {draft && <DraftMarker threadId={thread.id} compact={compact} />}
    </>
  );
}
