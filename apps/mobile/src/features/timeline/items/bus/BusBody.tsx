import { Text, View } from "react-native";
import { isString, listOf, str, type JsonObject } from "@canopy/domain/json";
import { plural } from "@canopy/domain/humanize";
import {
  agentsOf,
  deliveryOf,
  interactionsOf,
  summariesOf,
  transcriptOf,
  type ThreadSummary,
} from "@canopy/domain/tools";
import { statusLook } from "@canopy/domain/status-look";
import { Badge, StatusDot } from "../../../../ui/Badge";
import { Markdown } from "../../../../ui/markdown";
import { font, styles, useColors } from "../../../../ui/theme";
import { useTone } from "../../../../ui/tone";
import { useTimelineDirectory } from "../../directory";
import { EmptyNote, Section } from "../parts";
import { ThreadLink } from "./ThreadLink";

/** Recessed violet panel for agent-to-agent content: a task's prompt, a message (web: AgentWell). */
export function AgentWell({ label, text }: { label: string; text: string }) {
  const violet = useTone("violet");

  return (
    <View
      style={{
        gap: 4,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: violet.panel.ring,
        backgroundColor: `${violet.panel.background}99`,
      }}
    >
      <Text style={[styles.workMeta, { fontFamily: font.medium, color: violet.text }]}>{label}</Text>
      <Markdown text={text} breaks />
    </View>
  );
}

/** Facts about a call, one quiet line: "Starts from this thread's history · Its questions go to you". */
export function Facts({ lines }: { lines: readonly (string | false | undefined)[] }) {
  const c = useColors();
  const shown = lines.filter((line): line is string => typeof line === "string" && line !== "");

  return shown.length ? <Text style={[styles.workMeta, { color: c.muted }]}>{shown.join(" · ")}</Text> : null;
}

/** Threads a get_thread, wait_threads or list_threads call returned, with their live status (web: ThreadSummaryList). */
function ThreadSummaries({ threads }: { threads: readonly ThreadSummary[] }) {
  const c = useColors();
  const directory = useTimelineDirectory();

  return (
    <View style={{ gap: 8 }}>
      {threads.map((summary) => {
        const look = statusLook(directory.thread(summary.threadId)?.status || summary.status);

        const waits = [
          summary.lastTurn && `Last turn ${summary.lastTurn.charAt(0).toLowerCase()}${summary.lastTurn.slice(1)}`,
          summary.waitingForUser > 0 && `${plural(summary.waitingForUser, "question")} for you`,
          summary.waitingForParent > 0 && `${plural(summary.waitingForParent, "question")} for the parent agent`,
          summary.queuedTurns > 0 && `${plural(summary.queuedTurns, "turn")} queued`,
        ].filter(Boolean);

        return (
          <View key={summary.threadId} style={{ gap: 2 }}>
            <View style={styles.row}>
              <StatusDot tone={look.tone} />
              <ThreadLink threadId={summary.threadId} fallback={summary.title || "Untitled thread"} />
              <Text style={[styles.workMeta, { color: c.muted }]}>{look.label}</Text>
            </View>
            {waits.length > 0 && (
              <Text style={[styles.workMeta, { color: c.muted, paddingLeft: 14 }]}>{waits.join(" · ")}</Text>
            )}
            {summary.lastMessage ? (
              <Text numberOfLines={2} style={[styles.work, { color: c.soft, paddingLeft: 14 }]}>
                {summary.lastMessage}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** read_thread entries as a short transcript: messages as text, other items as one line of activity. */
function Transcript({ result }: { result: JsonObject }) {
  const c = useColors();

  return (
    <View style={{ gap: 6 }}>
      {transcriptOf(result).map((line) => (
        <Text
          key={line.key}
          numberOfLines={line.role === "activity" ? 1 : 4}
          style={[
            styles.work,
            line.role === "activity" ? { color: c.muted } : { color: c.soft },
            line.role === "user" && { alignSelf: "flex-end", textAlign: "right" },
            line.mono && { fontFamily: "monospace", fontSize: 12 },
          ]}
        >
          {line.text}
        </Text>
      ))}
    </View>
  );
}

/** list_interactions: what the side threads ask. */
function InteractionList({ result, settled }: { result: JsonObject; settled: boolean }) {
  const interactions = interactionsOf(result);

  if (!interactions.length) return settled ? <EmptyNote>Nothing is waiting for an answer.</EmptyNote> : null;

  return (
    <View style={{ gap: 8 }}>
      {interactions.map((interaction, index) => (
        <View key={index} style={[styles.row, { flexWrap: "wrap" }]}>
          <Badge tone="amber">{interaction.kind}</Badge>
          <Text style={[styles.work, { fontFamily: font.medium }]}>{interaction.tool}</Text>
          {interaction.threadId ? <ThreadLink threadId={interaction.threadId} fallback="Side thread" /> : null}
        </View>
      ))}
    </View>
  );
}

/** list_agents: the provider instances a subagent can run on. */
function AgentList({ result, settled }: { result: JsonObject; settled: boolean }) {
  const agents = agentsOf(result);

  if (!agents.length)
    return settled ? (
      <EmptyNote>No providers reported yet: a subagent starts as a copy of this agent.</EmptyNote>
    ) : null;

  return (
    <View style={{ gap: 6 }}>
      {agents.map((agent) => (
        <Facts key={agent.name} lines={[agent.name, agent.settings, agent.description]} />
      ))}
    </View>
  );
}

/** What a bus call did, in a shape made for its tool (web: AgentBusCallView's body). */
export function BusBody({
  tool,
  args,
  result,
  refused,
  running,
}: {
  tool: string;
  args: JsonObject;
  result: JsonObject;
  refused: boolean;
  running: boolean;
}) {
  const waitingFor = listOf(args["thread_ids"]).filter(isString);
  const threads = summariesOf(tool, result);
  const settled = !running && !refused;

  switch (tool) {
    case "spawn_thread":
      return (
        <>
          {str(args["prompt"]) ? <AgentWell label="Prompt" text={str(args["prompt"])} /> : null}
          {str(args["instructions"]) ? (
            <Section label="Instructions">
              <Markdown text={str(args["instructions"])} />
            </Section>
          ) : null}
          <Facts
            lines={[
              args["fork"] === true && "Starts from this thread's history",
              str(args["interactions"]) === "human" ? "Its questions go to you" : "Its questions come to this agent",
              args["notify"] === false && "No message when it finishes",
            ]}
          />
        </>
      );
    case "send_message":
      return (
        <>
          {str(args["prompt"]) ? <AgentWell label="Message" text={str(args["prompt"])} /> : null}
          {settled && (
            <Facts lines={[deliveryOf(args, result), args["notify"] === false && "No message when it finishes"]} />
          )}
        </>
      );
    case "wait_threads":
      return (
        <>
          <Facts
            lines={[
              str(args["until"]) === "all" ? "Until all finish" : waitingFor.length > 1 ? "Until one finishes" : "",
              result["done"] === false && "Stopped waiting; still working",
            ]}
          />
          {threads.length > 0 ? (
            <ThreadSummaries threads={threads} />
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {waitingFor.map((id) => (
                <ThreadLink key={id} threadId={id} />
              ))}
            </View>
          )}
        </>
      );
    case "get_thread":
    case "list_threads":
      return threads.length > 0 ? (
        <ThreadSummaries threads={threads} />
      ) : settled ? (
        <EmptyNote>No subagents yet.</EmptyNote>
      ) : null;
    case "read_thread":
      return transcriptOf(result).length > 0 ? (
        <Transcript result={result} />
      ) : settled ? (
        <EmptyNote>Nothing new in that thread.</EmptyNote>
      ) : null;
    case "list_interactions":
      return <InteractionList result={result} settled={settled} />;
    case "answer_interaction":
      return (
        <>
          {str(args["message"]) ? (
            <Section label="Message">
              <Markdown text={str(args["message"])} />
            </Section>
          ) : null}
          {str(result["status"]) ? (
            <Facts lines={[`The question is now ${statusLook(str(result["status"])).label.toLowerCase()}`]} />
          ) : null}
        </>
      );
    case "list_agents":
      return <AgentList result={result} settled={settled} />;
    case "schedule_wakeup":
    case "schedule_recurring":
      return str(args["prompt"]) ? <AgentWell label="Prompt" text={str(args["prompt"])} /> : null;
    default:
      return null;
  }
}
