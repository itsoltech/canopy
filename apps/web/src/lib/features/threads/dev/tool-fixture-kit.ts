import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, type Item } from "@canopy/contracts";
import { isString, type JsonObject, type JsonValue } from "#lib/shared/json.ts";

type ItemContent = MessageInitShape<typeof ItemSchema>["content"];

/** Thread ids and item builders shared by the tool-call gallery's fixtures (`/dev/tool-calls`). */
export const GALLERY_THREAD_ID = "01a19b4d-1bd5-77e2-aa45-1a2e404c1b89";
export const SIDE = "01a19868-b267-75e4-9a45-8a566cb687ce";
export const OTHER = "01a198ce-fe6b-757d-a524-4dd87fb54c63";

export const item = (id: string, content: ItemContent, status = ItemStatus.COMPLETED): Item =>
  create(ItemSchema, { itemId: id, status, content });

export const tool = (
  id: string,
  name: string,
  input: JsonValue,
  output: string,
  extra: { server?: string; isError?: boolean; status?: ItemStatus } = {},
): Item =>
  item(
    id,
    {
      case: "toolCall",
      value: {
        name,
        server: extra.server ?? "",
        inputJson: JSON.stringify(input),
        output,
        isError: extra.isError ?? false,
      },
    },
    extra.status,
  );

export const bus = (
  id: string,
  toolName: string,
  args: JsonValue,
  result: JsonValue,
  extra: { isError?: boolean; status?: ItemStatus; target?: string } = {},
): Item =>
  item(
    id,
    {
      case: "agentBusCall",
      value: {
        callId: id,
        toolName,
        argumentsJson: JSON.stringify(args),
        resultJson: isString(result) ? result : JSON.stringify(result),
        isError: extra.isError ?? false,
        targetThreadId: extra.target ?? "",
      },
    },
    extra.status,
  );

export const source = `import { describeTool } from "./registry.ts";

/** Formats a value for people. */
export function format(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
`;

export const numbered = (text: string, start = 1) =>
  text
    .split("\n")
    .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
    .join("\n");

export const summary = (title: string, status: string, last: string, extra: JsonObject = {}) => ({
  thread_id: title === "Lister" ? SIDE : OTHER,
  title,
  kind: "side",
  parent_thread_id: GALLERY_THREAD_ID,
  status,
  settled: status !== "running",
  queued_turns: 0,
  waiting_for_parent: 0,
  waiting_for_user: 0,
  model: "gpt-6.1-sol",
  effort: "high",
  permission_mode: "read_only",
  last_message: last,
  ...extra,
});
