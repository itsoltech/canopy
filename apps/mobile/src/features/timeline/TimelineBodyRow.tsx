import { memo } from "react";
import { StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { ShellMessage } from "../../ui/ShellMessage";
import { useMotion } from "../../ui/motion";
import { ItemView } from "./ItemView";
import { BackgroundNoteRow, ChecksNoteRow, NoticeRow } from "./NoticeRows";
import type { BodyRow } from "./turn-plan";
import { STEERED, UserMessageView } from "./UserMessageView";
import { ThreadScrollItem } from "../../ui/thread-scroll-items";

const styles = StyleSheet.create({
  workMessage: { paddingVertical: 8 },
});

/** Unchanged body rows retain their rendered subtree when a neighboring disclosure toggles. */
export const BodyRowView = memo(function BodyRowView({
  row,
  steers,
  ended,
  inWork = false,
}: {
  row: BodyRow;
  steers: readonly ui.Steer[];
  ended: boolean;
  inWork?: boolean;
}) {
  const { rise } = useMotion();

  if (row.kind === "notice" && !row.notice.notice) return null;
  const workMessage = inWork && row.kind === "item" && row.node.item.content.case === "agentMessage";

  return (
    <ThreadScrollItem id={row.key}>
      <Animated.View entering={rise.entering} style={workMessage && styles.workMessage}>
        <BodyRowContent row={row} steers={steers} ended={ended} />
      </Animated.View>
    </ThreadScrollItem>
  );
});

function BodyRowContent({ row, steers, ended }: { row: BodyRow; steers: readonly ui.Steer[]; ended: boolean }) {
  if (row.kind === "notice")
    return row.notice.notice ? <NoticeRow notice={row.notice.notice} state={row.notice} /> : null;
  const content = row.node.item.content;

  if (row.steer && content.case === "userMessage") {
    const steer = steers.find((s) => s.id === content.value.clientId);

    if (steer?.shellCommand !== undefined)
      return <ShellMessage command={steer.shellCommand} result={steer.shellResult} status={steer.status} />;

    if (steer?.backgroundItemIds.length) return <BackgroundNoteRow itemIds={steer.backgroundItemIds} />;

    if (steer?.prChecks.length) return <ChecksNoteRow notes={steer.prChecks} />;

    return (
      <UserMessageView
        text={steer?.text ?? content.value.text}
        mentions={steer?.mentions ?? content.value.mentions}
        attachments={steer?.attachments ?? []}
        note={STEERED}
        steerSourceId={steer?.sourceThreadId || content.value.authorAgentId}
        sender={steer?.sender}
        quotes={steer?.quotes}
      />
    );
  }

  return <ItemView node={row.node} turnEnded={ended} />;
}
