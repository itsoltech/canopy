import { useMemo, useState } from "react";
import { View } from "react-native";
import type { Item, Provider, ui } from "@canopy/contracts";
import { foldId, workFoldOpen, type WorkFoldChoice, type WorkFoldState } from "@canopy/domain/work-fold";
import { ShellMessage } from "../../ui/ShellMessage";
import { useDevicePreferences } from "../../state/preferences";
import { TurnDetails, TurnEnd } from "./TurnEnd";
import { TurnInput } from "./TurnInput";
import { TurnStart } from "./TurnStart";
import { segmentsOf, summarize, timestampMs, turnBody } from "./turn-plan";
import { WorkFold } from "./WorkFold";
import { QuoteItem } from "../quotes/QuoteAction";
import { BodyRowView } from "./TimelineBodyRow";
import { WorkRail } from "./WorkRail";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { ThreadScrollItem, useThreadScrollTarget } from "../../ui/thread-scroll-items";

/** What a turn looks up beyond its own items: the thread's notices and steers, its tasks and provider. */
export interface TurnContext {
  readonly notices: readonly ui.ThreadNotice[];
  readonly steers: readonly ui.Steer[];
  /** Background tasks by the command item that started them (they own its lifecycle after the turn). */
  readonly tasks: ReadonlyMap<string, Item>;
  readonly provider: Provider | undefined;
  /** Per timeline, so virtual cell remounts retain manual choices without persisting them to disk. */
  readonly foldChoices: Map<string, ReadonlyMap<number, WorkFoldChoice>>;
}

/** Only seed the disclosure that contains the saved row; later toggles retain normal fold rules. */
function initialFolds(turn: ui.Turn, entries: readonly ui.TimelineItem[], context: TurnContext, target?: string) {
  const saved = context.foldChoices.get(turn.id);

  if (saved || !target) return saved ?? new Map<number, WorkFoldChoice>();
  const body = turnBody(turn, entries, context.notices);
  const choices = new Map<number, WorkFoldChoice>();

  segmentsOf(turn, body, () => false).forEach((segment, index) => {
    const work = body.slice(segment.start + segment.inputs, segment.end);

    if (work.some((row) => row.key === target))
      choices.set(index, {
        open: true,
        state: {
          live: segment.live,
          answered: segment.answered,
          answerSeq: body[segment.answerBoundary]?.seq,
        },
      });
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
  const { workFold } = useDevicePreferences();
  const target = useThreadScrollTarget();

  const [folds, setFolds] = useState<ReadonlyMap<number, WorkFoldChoice>>(() =>
    initialFolds(turn, entries, context, target),
  );

  const body = useMemo(() => turnBody(turn, entries, context.notices), [turn, entries, context.notices]);
  const ended = ["completed", "interrupted", "failed", "cancelled"].includes(turn.status);
  const plan = segmentsOf(turn, body, () => false);

  const state = (index: number): WorkFoldState => {
    const segment = plan[index];
    const answer = segment ? body[segment.answerBoundary] : undefined;

    return {
      live: segment?.live ?? false,
      answered: segment?.answered ?? false,
      answerSeq: answer?.seq,
    };
  };

  const open = (index: number) => workFoldOpen(state(index), workFold, folds.get(index));

  const segments = segmentsOf(turn, body, open);
  const hasInput = Boolean(turn.inputText || turn.messageText || turn.attachments.length || turn.quotes.length);
  const lastAnswer = entries.findLast((entry) => entry.item?.content.case === "agentMessage")?.item;
  const answerText = lastAnswer?.content.case === "agentMessage" ? lastAnswer.content.value.text : "";

  const answerEnd = (at: number | undefined) => {
    const row = at === undefined ? undefined : body[at];

    return row?.kind === "item" ? row.completedAt : undefined;
  };

  return (
    <View style={{ gap: 12, paddingBottom: 12 }}>
      <View style={{ marginBottom: -8 }}>
        <TurnStart turn={turn} newDay={newDay} />
      </View>
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
                  : answerEnd(segments[index - 1]?.answer),
            endMs: index === segments.length - 1 ? timestampMs(turn.completedAt) : answerEnd(segment.answer),
            live: index === segments.length - 1 && segment.live,
          },
          context.tasks,
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
                    const next = new Map(folds).set(index, { open: !isOpen, state: state(index) });
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
                  expanded={segment.live && workFold.expandWhileWorking}
                />
              </TimelineDisclosure>
            </View>
            {/* Out of the fold the answer mounts anew, so it fades in where it lands (web: the answer slot). */}
            {answer && <BodyRowView row={answer} steers={context.steers} ended={ended} />}
          </View>
        );
      })}
      {ended && (
        <View style={{ gap: 4, marginTop: answerText.trim() && turn.status === "completed" ? -12 : 0 }}>
          <TurnEnd turn={turn} provider={context.provider} historical={historical} />
          <QuoteItem.Provider value={lastAnswer?.itemId ?? ""}>
            <TurnDetails turn={turn} answer={answerText} />
          </QuoteItem.Provider>
        </View>
      )}
    </View>
  );
}
