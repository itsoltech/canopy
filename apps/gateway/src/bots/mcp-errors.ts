import { Option, Predicate, Schema } from "effect";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type McpPhase = "initialize" | "tools/list" | "tools/call" | "oauth/token";

export type McpFailureKind = "http" | "oauth" | "protocol" | "network" | "timeout";

/** Internal only: the connector boundary redacts these fields before logging or storing them. */
export class McpFailure extends Error {
  constructor(
    readonly kind: McpFailureKind,
    readonly phase: McpPhase,
    readonly status = 0,
    readonly serverCode = "",
    readonly serverMessage = "",
  ) {
    super("MCP request failed");
  }
}

const networkCause = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
  }),
);

export function networkMcpFailure(cause: unknown, phase: McpPhase, signal: AbortSignal): McpFailure {
  const parsed = networkCause(cause);
  const error = Option.getOrUndefined(parsed);

  return new McpFailure(
    signal.aborted ? "timeout" : "network",
    phase,
    0,
    error?.cause?.code ?? error?.code ?? "",
    error?.message ?? "",
  );
}

const errorBody = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.optional(
      Schema.Union([
        Schema.String,
        Schema.Struct({ code: Schema.Union([Schema.String, Schema.Number]), message: Schema.String }),
      ]),
    ),
    error_description: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);

/** Read at most 16 KiB; HTML, headers and arbitrary JSON fields are never retained. */
export async function httpMcpFailure(
  response: Pick<Response, "body" | "status">,
  phase: McpPhase,
): Promise<McpFailure> {
  const reader = response.body?.getReader();
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder();

  try {
    while (reader) {
      const chunk = await reader.read();

      if (chunk.done) break;
      bytes += chunk.value.length;

      if (bytes > 16_384) break;
      body += decoder.decode(chunk.value, { stream: true });
    }

    body += decoder.decode();
  } catch {
    // The HTTP status remains useful even if the response body is interrupted.
  } finally {
    await reader?.cancel().catch(() => undefined);
  }

  try {
    const parsed = errorBody(JSON.parse(body));

    if (Option.isSome(parsed)) {
      const { error, error_description, message } = parsed.value;

      if (Predicate.isString(error))
        return new McpFailure("oauth", phase, response.status, error, error_description ?? message ?? "");

      if (error) return new McpFailure("http", phase, response.status, String(error.code), error.message);

      return new McpFailure("http", phase, response.status, "", message ?? "");
    }
  } catch {
    // Not a supported JSON error envelope. Never retain a raw response body.
  }

  return new McpFailure("http", phase, response.status);
}

export function protocolMcpFailure(cause: unknown, phase: McpPhase, signal: AbortSignal): McpFailure {
  if (signal.aborted || (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout))
    return new McpFailure("timeout", phase);

  if (cause instanceof McpFailure) return cause;

  if (cause instanceof McpError) return new McpFailure("protocol", phase, 0, String(cause.code), cause.message);

  // Schema/JSON parsing failures can contain arbitrary response data; retain only the category.
  return new McpFailure("protocol", phase, 0, "invalid_response");
}
