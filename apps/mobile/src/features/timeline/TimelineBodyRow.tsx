import { memo } from "react";
import Animated from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { ShellMessage } from "../../ui/ShellMessage";
import { useMotion } from "../../ui/motion";
import { ItemView } from "./ItemView";
import { BackgroundNoteRow, NoticeRow } from "./NoticeRows";
import type { BodyRow } from "./turn-plan";
import { STEERED, UserMessageView } from "./UserMessageView";

/** Unchanged body rows retain their rendered subtree when a neighboring disclosure toggles. */
export const BodyRowView = memo(function BodyRowView({
  row,
  steers,
  ended,
}: {
  row: BodyRow;
  steers: readonly ui.Steer[];
  ended: boolean;
}) {
  const { rise } = useMotion();

  if (row.kind === "notice" && !row.notice.notice) return null;

  return (
    <Animated.View entering={rise.entering}>
      <BodyRowContent row={row} steers={steers} ended={ended} />
    </Animated.View>
  );
});

function BodyRowContent({ row, steers, ended }: { row: BodyRow; steers: readonly ui.Steer[]; ended: boolean }) {
  if (row.kind === "notice") return row.notice.notice ? <NoticeRow notice={row.notice.notice} /> : null;
  const content = row.node.item.content;

  if (row.steer && content.case === "userMessage") {
    const steer = steers.find((s) => s.id === content.value.clientId);

    if (steer?.shellCommand !== undefined)
      return <ShellMessage command={steer.shellCommand} result={steer.shellResult} status={steer.status} />;

    if (steer?.backgroundItemIds.length) return <BackgroundNoteRow itemIds={steer.backgroundItemIds} />;

    return (
      <UserMessageView
        text={steer?.text ?? content.value.text}
        mentions={steer?.mentions ?? content.value.mentions}
        attachments={steer?.attachments ?? []}
        note={STEERED}
        fromAgent={Boolean(content.value.authorAgentId)}
        sender={steer?.sender}
        quotes={steer?.quotes}
      />
    );
  }

  return <ItemView node={row.node} turnEnded={ended} />;
}
