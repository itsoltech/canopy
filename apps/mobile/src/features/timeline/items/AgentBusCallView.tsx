import { Text, View } from "react-native";
import { ItemStatus, type AgentBusCall } from "@canopy/contracts";
import { isString, listOf, parseObject, str } from "@canopy/domain/json";
import { plural } from "@canopy/domain/humanize";
import { busError, busLook, summariesOf, transcriptOf } from "@canopy/domain/tools";
import { styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { useTimelineDirectory } from "../directory";
import { ItemFrame } from "../ItemFrame";
import { BusBody } from "./bus/BusBody";
import { MessageDeliveryCard, SubagentCard } from "./bus/BusCards";
import { ThreadLink } from "./bus/ThreadLink";
import { Aside, ErrorText, RawToggle, useRoomyRows } from "./parts";

const TITLED = new Set(["send_message", "get_thread", "read_thread", "interrupt_thread", "close_thread"]);

/** Interrupting, closing and cancelling say all in their title; the rest open to their details. */
const TITLE_ONLY = new Set(["interrupt_thread", "close_thread", "cancel_schedule"]);

/**
 * A call on the agent bus (docs/agent-bus.md) (web: AgentBusCallView): starting or messaging another thread,
 * waiting for threads, reading them, answering interactions, schedules. Violet marks agent-to-agent activity; the
 * threads it is about are named in the title. A started subagent gets a card that follows the child thread, a
 * sent message one that follows the turn it reached.
 */
export function AgentBusCallView({ call, status }: { call: AgentBusCall; status: ItemStatus }) {
  const c = useColors();
  const violet = useTone("violet").text;
  const directory = useTimelineDirectory();
  const roomy = useRoomyRows();
  const tool = call.toolName;
  const args = parseObject(call.argumentsJson);
  const result = parseObject(call.resultJson);
  const running = status === ItemStatus.IN_PROGRESS;
  const failed = call.isError || status === ItemStatus.FAILED;
  const look = busLook(tool, args, running, call.isError);
  const target = call.targetThreadId || str(result["thread_id"]) || str(args["thread_id"]);
  const waitingFor = listOf(args["thread_ids"]).filter(isString);
  const fallback = str(args["title"]) || "Side thread";

  // The thread it is about, by name (the pill in the title); a wait names its first thread and how many more.
  const about = TITLED.has(tool) && target ? target : tool === "wait_threads" ? (waitingFor[0] ?? "") : "";
  const more = tool === "wait_threads" && waitingFor.length > 1 ? `+${waitingFor.length - 1}` : "";
  const aboutTitle = about ? directory.thread(about)?.title || (tool === "wait_threads" ? "Thread" : fallback) : "";

  const detail =
    failed || running
      ? ""
      : tool === "read_thread"
        ? plural(transcriptOf(result).length, "entry", "entries")
        : tool === "wait_threads"
          ? result["done"] === false
            ? "Still working"
            : summariesOf(tool, result).length > 0
              ? "Done"
              : ""
          : tool === "list_threads"
            ? plural(summariesOf(tool, result).length, "thread")
            : "";

  const subagent = tool === "spawn_thread" && !call.isError && target !== "";
  const message = tool === "send_message" && !call.isError && target !== "" && call.resultJson !== "";

  const spawned = {
    provider: str(result["provider"]) || str(args["provider"]),
    model: str(result["model"]) || str(args["model"]),
    effort: str(result["effort"]) || str(args["effort"]),
    permissionMode: str(result["permission_mode"]) || str(args["permission_mode"]),
  };

  const body = failed || !TITLE_ONLY.has(tool);

  return (
    <ItemFrame
      icon={look.icon}
      tone={call.isError ? "rose" : "violet"}
      status={status}
      label={[look.title, aboutTitle, more].filter(Boolean).join(" ")}
      title={
        <View style={[styles.row, { gap: 6, minWidth: 0 }]}>
          <Text numberOfLines={1} style={[styles.work, { flexShrink: 0, maxWidth: "70%", color: violet }]}>
            {look.title}
          </Text>
          {about ? <ThreadLink threadId={about} fallback={tool === "wait_threads" ? "Thread" : fallback} /> : null}
          {more ? <Text style={[styles.workMeta, { color: c.muted }]}>{more}</Text> : null}
        </View>
      }
      aside={
        <>
          {detail && roomy ? <Aside>{detail}</Aside> : null}
          {call.isError && status !== ItemStatus.FAILED && <Aside tone="rose">Refused</Aside>}
        </>
      }
    >
      {body ? (
        <View style={{ gap: 8 }}>
          {call.isError && <ErrorText text={busError(call.resultJson, tool) || "The call was refused."} />}
          <BusBody tool={tool} args={args} result={result} refused={call.isError} running={running} />
          <RawToggle
            parts={[
              { label: "Arguments", text: call.argumentsJson === "{}" ? "" : call.argumentsJson },
              { label: "Result", text: call.resultJson },
            ]}
          />
          {subagent && <SubagentCard threadId={target} title={str(args["title"]) || "Subagent"} spawned={spawned} />}
          {message && (
            <MessageDeliveryCard callId={call.callId} threadId={target} sentDelivery={str(result["delivery"])} />
          )}
        </View>
      ) : undefined}
    </ItemFrame>
  );
}
