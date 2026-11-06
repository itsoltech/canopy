import { ItemStatus, type ToolCall } from "@canopy/contracts";
import { parseObject } from "@canopy/domain/json";
import {
  describeTool,
  diffCounts,
  shellCommand,
  stripReminders,
  toolChanges,
  unwrapContent,
} from "@canopy/domain/tools";
import { Diff } from "../../../ui/Diff";
import { CodeBlock, OutputBlock } from "../CodeBlock";
import { ItemFrame } from "../ItemFrame";
import { Aside, DiffCounts, RawToggle, RowTitle, Section, useRoomyRows } from "./parts";

/**
 * Built-in, MCP or dynamic tool as the shared registry describes it (web: ToolCallView): a title in words with its
 * subject; inside, an edit's diff, a shell call's command or the result, and the raw input and result behind
 * "Show raw".
 */
export function ToolCallView({ call, status }: { call: ToolCall; status: ItemStatus }) {
  const roomy = useRoomyRows();
  const look = describeTool({ ...call, running: status === ItemStatus.IN_PROGRESS });
  const input = parseObject(call.inputJson);
  const failed = call.isError || status === ItemStatus.FAILED;
  const edit = look.body === "edit" || look.body === "patch";
  const changes = edit ? toolChanges(call.name, input) : [];
  const counts = edit ? diffCounts(changes) : undefined;
  const result = stripReminders(unwrapContent(call.output));

  const title = call.connectorAccountId
    ? `${call.server} · ${call.connectorAccountName} · ${call.name.split("__").at(-1)?.replaceAll("_", " ") ?? ""}`
    : look.title;

  return (
    <ItemFrame
      icon={look.icon}
      status={status}
      tone={failed ? "rose" : "neutral"}
      label={[title, look.subject].filter(Boolean).join(" ")}
      title={<RowTitle lead={title} subject={look.subject} mono={look.mono} />}
      aside={
        <>
          {counts && <DiffCounts {...counts} />}
          {look.detail && roomy ? <Aside>{look.detail}</Aside> : null}
          {call.isError && status !== ItemStatus.FAILED && <Aside tone="rose">Error</Aside>}
        </>
      }
    >
      {edit ? (
        changes.map((change, index) => (
          <Diff key={index} diff={change.diff} label={change.movePath || change.path || "Change"} />
        ))
      ) : look.body === "shell" ? (
        <>
          <CodeBlock text={shellCommand(input)} label="Command" />
          <OutputBlock
            output={result}
            label="Output"
            empty={status === ItemStatus.IN_PROGRESS ? "Waiting for output…" : "No output."}
          />
        </>
      ) : (
        <Section label="Result">
          <OutputBlock
            output={result}
            label={`Result of ${title}`}
            empty={status === ItemStatus.IN_PROGRESS ? "Waiting for the result…" : "No result."}
          />
        </Section>
      )}
      <RawToggle
        parts={[
          { label: "Input", text: call.inputJson === "{}" || call.inputJson === "null" ? "" : call.inputJson },
          { label: "Result", text: call.output },
        ]}
      />
    </ItemFrame>
  );
}
