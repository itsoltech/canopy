import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import { redactToolOutput } from "../providers/secret-tool-output.ts";

const text = z.string().min(1);
const record = z.record(z.string(), z.json());

export interface StagedCapture {
  call: AutomationCall;
  /** Move the file to where the agent asked for it, once the capture is known to hide the values. */
  publish(result: CallToolResult | undefined): CallToolResult | undefined;
  discard(): void;
}

/** Rewrite paths inside JSON text through its parsed strings, so escaping stays valid; plain text as it is. */
function moveText(text: string, move: (value: string) => string): string {
  try {
    return JSON.stringify(redactToolOutput(z.json().parse(JSON.parse(text)), move));
  } catch {
    return move(text);
  }
}

/**
 * A screenshot is written to a private staging directory first. Only a capture that passed the checks reaches
 * the path the agent chose; a discarded one is deleted, so its file cannot be read either.
 */
export function stageCapture(call: AutomationCall): StagedCapture {
  const directory = mkdtempSync(join(tmpdir(), "canopy-capture-"));
  const extension = call.arguments["format"] === "jpeg" ? "jpg" : "png";
  const staged = join(directory, `capture.${extension}`);
  const { path, screenshotDir, ...rest } = call.arguments;
  const requested = text.safeParse(path);
  const folder = text.safeParse(screenshotDir);

  const destination = requested.success
    ? requested.data
    : join(
        folder.success ? folder.data : join(tmpdir(), "agent-browser-screenshots"),
        `screenshot-${Date.now()}-${crypto.randomUUID()}.${extension}`,
      );

  const discard = () => rmSync(directory, { recursive: true, force: true });

  return {
    call: { ...call, arguments: { ...rest, path: staged } },
    discard,
    publish(result) {
      try {
        if (!result || result.isError || !existsSync(staged)) return result;
        mkdirSync(dirname(destination), { recursive: true });
        // A generated name is never reused; a requested path is overwritten, as the tool would.
        copyFileSync(staged, destination, requested.success ? 0 : constants.COPYFILE_EXCL);
        const move = (value: string) => value.replaceAll(staged, () => destination);
        const structured = record.safeParse(result.structuredContent);

        return {
          ...result,
          content: result.content.map((block) =>
            block.type === "text" ? { ...block, text: moveText(block.text, move) } : block,
          ),
          ...(structured.success && {
            structuredContent: record.parse(redactToolOutput(structured.data, move)),
          }),
        };
      } finally {
        discard();
      }
    },
  };
}
