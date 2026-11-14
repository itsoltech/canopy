import { type JsonSchema, Schema } from "effect";
import { AGENT_BUS_TOOL_NAMES, AGENT_BUS_TOOLS, SpawnThread, type AgentBusToolName } from "./tools.ts";

export interface ToolJsonSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema.JsonSchema;
}

/** Tool specs for providers: Codex dynamicTools ({ name, description, inputSchema }) and the Claude MCP server. */
export function agentBusToolSpecs(names: readonly AgentBusToolName[] = AGENT_BUS_TOOL_NAMES): ToolJsonSpec[] {
  return names.flatMap((name) => {
    if (name === "import_image_reply") return [];
    const tool = AGENT_BUS_TOOLS[name];

    // Old workers may still send permission_mode. Decode it only to narrow access; new models never choose it.
    const args =
      tool.name === "spawn_thread"
        ? SpawnThread.mapFields(({ permission_mode: _legacy, ...fields }) => fields)
        : tool.args;

    const document = Schema.toJsonSchemaDocument(args, { onExcessProperty: "error" });
    const schema = document.schema;

    // Providers require an object schema; an empty Struct compiles to "anything but null".
    const inputSchema =
      schema["type"] === "object" ? schema : { type: "object", properties: {}, additionalProperties: false };

    return [
      {
        name: tool.name,
        description: tool.description,
        inputSchema: { ...inputSchema, ...definitions(document) },
      },
    ];
  });
}

function definitions(document: JsonSchema.Document<"draft-2020-12">): { readonly $defs?: JsonSchema.Definitions } {
  return document.definitions && Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};
}
