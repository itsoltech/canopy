import { useMemo, useState } from "react";
import { View } from "react-native";
import type { Item, Provider, ui } from "@canopy/contracts";
import {
  foldId,
  isPublishedReply,
  turnProgress,
  workFoldOpen,
  type WorkFoldChoice,
  type WorkFoldState,
} from "@canopy/domain/work-fold";
import type { WorkGroupChoices } from "@canopy/domain/work-group-choices";
import type { NoticeState } from "@canopy/domain/turn-notices";
import { ShellMessage } from "../../ui/ShellMessage";
import { useDevicePreferences } from "../../state/preferences";
import { TurnDetails, TurnEnd } from "./TurnEnd";
import { TurnInput } from "./TurnInput";
import { TurnStart } from "./TurnStart";
import { segmentsOf, summarize, timestampMs, turnBody, type BodyRow } from "./turn-plan";
import { WorkFold } from "./WorkFold";
import { QuoteItem } from "../quotes/QuoteAction";
import { BodyRowView } from "./TimelineBodyRow";
import { WorkRail } from "./WorkRail";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { useTimelineDirectory } from "./directory";
import { ThreadScrollItem, useThreadScrollTarget } from "../../ui/thread-scroll-items";
import { ReplyMessageContext, ReplySuggestions, useTurnReplySuggestions } from "./ReplySuggestions";

/** What a turn looks up beyond its own items: the thread's notices and steers, its tasks and provider. */
export interface TurnContext {
  readonly loginCommand: string;
  readonly notices: readonly (ui.ThreadNotice & NoticeState)[];
  readonly steers: readonly ui.Steer[];
  /** Background tasks by the command item that started them (they own its lifecycle after the turn). */
  readonly tasks: ReadonlyMap<string, Item>;
  readonly provider: Provider | undefined;
  /** The thread's instance connects through a proxy: its failures cannot name the user's plan. */
  readonly proxy: boolean;
  /** Per timeline, so virtual cell remounts retain manual choices without persisting them to disk. */
  readonly foldChoices: Map<string, ReadonlyMap<number, WorkFoldChoice>>;
  readonly groupChoices: WorkGroupChoices;
}

/** Published results and billing notices remain outside collapsed work. */
const isReplyRow = (row: BodyRow) =>
  row.kind === "item" ? isPublishedReply(row.node.item.content) : row.notice.notice?.code === "extra_usage";

const isModelChange = (row: BodyRow) => row.kind === "item" && row.node.item.content.case === "modelChange";
const isFoldBody = (row: BodyRow) => !isReplyRow(row) && !isModelChange(row);

const replyResults = (body: readonly BodyRow[], ended: boolean) =>
  body.filter((row) => isReplyRow(row) && (ended || row.kind === "notice"));

const answerEnd = (body: readonly BodyRow[], at: number | undefined) => {
  const row = at === undefined ? undefined : body[at];

  return row?.kind === "item" ? row.completedAt : undefined;
};

function foldState(
  segment: ReturnType<typeof segmentsOf>[number] | undefined,
  body: readonly BodyRow[],
): WorkFoldState {
  return {
    live: segment?.live ?? false,
    answered: segment?.answered ?? false,
    answerSeq: segment ? body[segment.answerBoundary]?.seq : undefined,
  };
}

/** Only seed the disclosure that contains the saved row; later toggles retain normal fold rules. */
function initialFolds(turn: ui.Turn, entries: readonly ui.TimelineItem[], context: TurnContext, target?: string) {
  const saved = context.foldChoices.get(turn.id);

  if (saved || !target) return saved ?? new Map<number, WorkFoldChoice>();
  const body = turnBody(turn, entries, context.notices).filter(isFoldBody);
  const choices = new Map<number, WorkFoldChoice>();

  segmentsOf(turn, body, () => false).forEach((segment, index) => {
    const work = body.slice(segment.start + segment.inputs, segment.end);

    if (work.some((row) => row.key === target)) choices.set(index, { open: true, state: foldState(segment, body) });
  });

  return choices;
}

/**
 * One turn of the thread (web: buildTimeline + foldTurns + FeedRowView): its start and input, then per segment its
 * leading steers, the "Working for …" fold with the work under it, the answer, and how the turn ended.
 * Settings → Threads → Turn activity decides each fold; live taps expire at its answer/end boundary.
 */
export function TimelineTurn({
  turn,
  entries,
  context,
  newDay,
  historical,
}: {
  turn: ui.Turn;
  entries: readonly ui.TimelineItem[];
  context: TurnContext;
  newDay: boolean;
  historical: boolean;
}) {
  const { workFold, values } = useDevicePreferences();
  const target = useThreadScrollTarget();
  const directory = useTimelineDirectory();
  const replies = useTurnReplySuggestions(turn, entries);

  const [folds, setFolds] = useState<ReadonlyMap<number, WorkFoldChoice>>(() =>
    initialFolds(turn, entries, context, target),
  );

  const allBody = useMemo(() => turnBody(turn, entries, context.notices), [turn, entries, context.notices]);

  const body = allBody.filter(isFoldBody);
  const ended = turnProgress(turn.status) !== "live";
  const plan = segmentsOf(turn, body, () => false);

  const open = (index: number) => workFoldOpen(foldState(plan[index], body), workFold, folds.get(index));

  const segments = segmentsOf(turn, body, open);
  const hasInput = Boolean(turn.inputText || turn.messageText || turn.attachments.length || turn.quotes.length);
  const answerText = replies.answerText;

  return (
    <ReplyMessageContext.Provider value={replies.context}>
      <View style={{ gap: 12, paddingBottom: 12 }}>
        <View style={{ marginBottom: -8 }}>
          <TurnStart turn={turn} newDay={newDay} />
        </View>
        {allBody.filter(isModelChange).map((row) => (
          <BodyRowView key={row.key} row={row} steers={context.steers} ended={ended} />
        ))}
        {turn.shellCommand !== undefined ? (
          <ShellMessage command={turn.shellCommand} result={turn.shellResult} status={turn.status} error={turn.error} />
        ) : hasInput ? (
          <ThreadScrollItem id="input">
            <TurnInput turn={turn} />
          </ThreadScrollItem>
        ) : null}
        {segments.map((segment, index) => {
          const id = foldId(turn.id, index);
          const answer = segment.answer >= 0 ? body[segment.answer] : undefined;
          const work = body.slice(segment.start + segment.inputs, segment.end).filter((row) => row !== answer);
          const isOpen = open(index);

          const summary = summarize(
            work,
            {
              startMs:
                index === 0
                  ? timestampMs(turn.startedAt)
                  : segment.inputs
                    ? undefined
                    : answerEnd(body, segments[index - 1]?.answer),
              endMs: index === segments.length - 1 ? timestampMs(turn.completedAt) : answerEnd(body, segment.answer),
              live: index === segments.length - 1 && segment.live,
            },
            context.tasks,
            (id) => directory.thread(id)?.title,
          );

          return (
            <View key={id} style={{ gap: 12 }}>
              {body.slice(segment.start, segment.start + segment.inputs).map((row) => (
                <BodyRowView key={row.key} row={row} steers={context.steers} ended={ended} />
              ))}
              <View>
                <ThreadScrollItem id={`work:${id}`}>
                  <WorkFold
                    summary={summary}
                    starting={turn.status === "queued" && turn.dispatched}
                    open={isOpen}
                    onToggle={() => {
                      const choices = context.foldChoices.get(turn.id) ?? folds;
                      const currentState = foldState(plan[index], body);
                      const expanded = workFoldOpen(currentState, workFold, choices.get(index));
                      const next = new Map(choices).set(index, { open: !expanded, state: currentState });
                      context.foldChoices.set(turn.id, next);
                      setFolds(next);
                    }}
                  />
                </ThreadScrollItem>
                <TimelineDisclosure open={isOpen && work.length > 0}>
                  <WorkRail
                    work={work}
                    steers={context.steers}
                    ended={ended}
                    expanded={values.workToolCalls === "expanded"}
                    choices={context.groupChoices}
                  />
                </TimelineDisclosure>
              </View>
              {/* Out of the fold the answer mounts anew, so it fades in where it lands (web: the answer slot). */}
              {answer && <BodyRowView row={answer} steers={context.steers} ended={ended} />}
            </View>
          );
        })}
        {replyResults(allBody, ended).map((row) => (
          <BodyRowView key={row.key} row={row} steers={context.steers} ended={ended} />
        ))}
        {ended && <TurnFooter {...{ turn, context, historical, answerText }} itemId={replies.answerItemId} />}
        {replies.itemId && replies.replies.length > 0 && (
          <ReplySuggestions
            itemId={replies.itemId}
            replies={replies.replies}
            disabled={historical || turn.inherited || Boolean(turn.rewindId)}
          />
        )}
      </View>
    </ReplyMessageContext.Provider>
  );
}

function TurnFooter({
  turn,
  context,
  historical,
  answerText,
  itemId,
}: {
  turn: ui.Turn;
  context: TurnContext;
  historical: boolean;
  answerText: string;
  itemId: string;
}) {
  return (
    <View style={{ gap: 4, marginTop: answerText.trim() && turn.status === "completed" ? -12 : 0 }}>
      <TurnEnd
        loginCommand={context.loginCommand}
        turn={turn}
        provider={context.provider}
        proxy={context.proxy}
        historical={historical}
      />
      <QuoteItem.Provider value={itemId}>
        <TurnDetails turn={turn} answer={answerText} />
      </QuoteItem.Provider>
    </View>
  );
}
