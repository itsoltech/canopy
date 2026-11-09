import { useState } from "react";
import { View } from "react-native";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import type { Item, Provider, ui } from "@canopy/contracts";
import { foldId, workFoldOpen } from "@canopy/domain/work-fold";
import { LatestScope } from "../../ui/feed-anchor";
import { ShellMessage } from "../../ui/ShellMessage";
import { useMotion } from "../../ui/motion";
import { useColors } from "../../ui/theme";
import { useDevicePreferences } from "../../state/preferences";
import { ItemView } from "./ItemView";
import { BackgroundNoteRow, NoticeRow } from "./NoticeRows";
import { TurnDetails, TurnEnd } from "./TurnEnd";
import { TurnInput } from "./TurnInput";
import { TurnStart } from "./TurnStart";
import { segmentsOf, summarize, timestampMs, turnBody, workRows, type BodyRow, type WorkRow } from "./turn-plan";
import { STEERED, UserMessageView } from "./UserMessageView";
import { WorkFold, WorkGroup } from "./WorkFold";

/** What a turn looks up beyond its own items: the thread's notices and steers, its tasks and provider. */
export interface TurnContext {
  readonly notices: readonly ui.ThreadNotice[];
  readonly steers: readonly ui.Steer[];
  /** Background tasks by the command item that started them (they own its lifecycle after the turn). */
  readonly tasks: ReadonlyMap<string, Item>;
  readonly provider: Provider | undefined;
}

/**
 * One body row (web: TimelineRowView). A row that arrives after its turn is on screen (a new item, an answer leaving
 * the fold) fades in (web `t-rise`); the rows a turn mounts with appear at once (the cell's LayoutAnimationConfig).
 */
function BodyRowView({ row, steers, ended }: { row: BodyRow; steers: readonly ui.Steer[]; ended: boolean }) {
  const { rise } = useMotion();

  if (row.kind === "notice" && !row.notice.notice) return null;

  return (
    <Animated.View entering={rise.entering}>
      <BodyRowContent row={row} steers={steers} ended={ended} />
    </Animated.View>
  );
}

/** What a body row shows: an item (a steer as the message it is), or a notice. */
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

/** The rows an open fold shows, hanging off a rail under its chevron (web: FeedRowView `work`). */
function WorkRail({
  rows,
  steers,
  ended,
  groups,
  onGroup,
}: {
  rows: readonly WorkRow[];
  steers: readonly ui.Steer[];
  ended: boolean;
  groups: (key: string) => boolean;
  onGroup: (key: string) => void;
}) {
  const c = useColors();
  const { rise } = useMotion();

  // The feed is an inverted list held by the fold's anchor: an opened fold fades in without animating its height.
  return (
    <Animated.View
      entering={rise.entering}
      style={{ marginLeft: 8, paddingLeft: 16, borderLeftWidth: 1, borderColor: c.rule, gap: 4 }}
    >
      <LayoutAnimationConfig skipEntering>
        {rows.map((row) =>
          row.kind === "row" ? (
            <BodyRowView key={row.row.key} row={row.row} steers={steers} ended={ended} />
          ) : (
            // A group's rows hang off the same rail as its header (web: work-group rows).
            <View key={row.key} style={{ gap: 4 }}>
              <WorkGroup
                label={row.label}
                open={groups(row.key)}
                running={row.running}
                onToggle={() => onGroup(row.key)}
              />
              {row.rows.map((inner) => (
                <BodyRowView key={inner.key} row={inner} steers={steers} ended={ended} />
              ))}
            </View>
          ),
        )}
      </LayoutAnimationConfig>
    </Animated.View>
  );
}

/**
 * One turn of the thread (web: buildTimeline + foldTurns + FeedRowView): its start and input, then per segment its
 * leading steers, the "Working for …" fold with the work under it, the answer, and how the turn ended.
 * Settings → Threads → Turn activity decides each fold until the reader taps it; the tap wins for the visit.
 */
export function TimelineTurn({
  turn,
  entries,
  context,
  newDay,
  latest,
  onQueued,
}: {
  turn: ui.Turn;
  entries: readonly ui.TimelineItem[];
  context: TurnContext;
  newDay: boolean;
  latest: boolean;
  onQueued?: (turn: ui.Turn) => void;
}) {
  const { workFold } = useDevicePreferences();
  const [folds, setFolds] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [groups, setGroups] = useState<ReadonlyMap<string, boolean>>(new Map());
  const body = turnBody(turn, entries, context.notices);
  const ended = ["completed", "interrupted", "failed", "cancelled"].includes(turn.status);
  const plan = segmentsOf(turn, body, () => false);

  const open = (index: number) =>
    workFoldOpen(plan[index]?.live ?? false, plan[index]?.answered ?? false, workFold, folds.get(index));

  const segments = segmentsOf(turn, body, open);
  const queued = onQueued && turn.status === "queued" && !turn.dispatched && !turn.fromThreadId;
  const hasInput = Boolean(turn.inputText || turn.messageText || turn.attachments.length || turn.quotes.length);
  const lastAnswer = entries.findLast((entry) => entry.item?.content.case === "agentMessage")?.item?.content;
  const answerText = lastAnswer?.case === "agentMessage" ? lastAnswer.value.text : "";

  const answerEnd = (at: number | undefined) => {
    const row = at === undefined ? undefined : body[at];

    return row?.kind === "item" ? row.completedAt : undefined;
  };

  return (
    <LatestScope latest={latest}>
      <View style={{ gap: 12, paddingBottom: 12 }}>
        <View style={{ marginBottom: -8 }}>
          <TurnStart turn={turn} newDay={newDay} />
        </View>
        {turn.shellCommand !== undefined ? (
          <ShellMessage command={turn.shellCommand} result={turn.shellResult} status={turn.status} error={turn.error} />
        ) : hasInput ? (
          <TurnInput turn={turn} onActions={queued ? () => onQueued(turn) : undefined} />
        ) : null}
        {segments.map((segment, index) => {
          const id = foldId(turn.id, index);
          const answer = segment.answer >= 0 ? body[segment.answer] : undefined;
          const work = body.slice(segment.start + segment.inputs, segment.end).filter((row) => row !== answer);
          const isOpen = open(index);

          const summary = summarize(
            work,
            {
              startMs: index === 0 ? timestampMs(turn.startedAt) : answerEnd(segments[index - 1]?.answer),
              endMs: index === segments.length - 1 ? timestampMs(turn.completedAt) : answerEnd(segment.answer),
              live: segment.live,
            },
            context.tasks,
          );

          const groupOpen = (key: string) => groups.get(key) ?? (segment.live && workFold.expandWhileWorking);

          return (
            <View key={id} style={{ gap: 12 }}>
              {body.slice(segment.start, segment.start + segment.inputs).map((row) => (
                <BodyRowView key={row.key} row={row} steers={context.steers} ended={ended} />
              ))}
              <View style={{ gap: 4 }}>
                <WorkFold
                  summary={summary}
                  starting={turn.status === "queued" && turn.dispatched}
                  open={isOpen}
                  onToggle={() => setFolds(new Map(folds).set(index, !isOpen))}
                />
                {isOpen && work.length > 0 && (
                  <WorkRail
                    rows={workRows(work, groupOpen)}
                    steers={context.steers}
                    ended={ended}
                    groups={groupOpen}
                    onGroup={(key) => setGroups(new Map(groups).set(key, !groupOpen(key)))}
                  />
                )}
              </View>
              {/* Out of the fold the answer mounts anew, so it fades in where it lands (web: the answer slot). */}
              {answer && <BodyRowView row={answer} steers={context.steers} ended={ended} />}
            </View>
          );
        })}
        {ended && (
          <View style={{ gap: 4 }}>
            <TurnEnd turn={turn} provider={context.provider} />
            <TurnDetails turn={turn} answer={answerText} />
          </View>
        )}
      </View>
    </LatestScope>
  );
}
