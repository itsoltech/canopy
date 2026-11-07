import { createHash } from "node:crypto";

export const ENVIRONMENT_BEGIN = "<!-- canopy:agent-environment:begin -->";
export const ENVIRONMENT_END = "<!-- canopy:agent-environment:end -->";
export const ENVIRONMENT_CONTENT_BYTES = 24 * 1024;
export const INSTRUCTION_DOCUMENT_NAME_LENGTH = 120;
export const ENVIRONMENT_FILE_BYTES = 256 * 1024;

export const environmentDigest = (content: string): string => createHash("sha256").update(content).digest("hex");

export const environmentBlock = (content: string): string => `${ENVIRONMENT_BEGIN}\n${content}\n${ENVIRONMENT_END}`;

export interface EnvironmentBlock {
  readonly before: string;
  readonly content: string;
  readonly after: string;
}

/** Exactly one complete, line-aligned managed block; malformed/duplicate markers are never adopted. */
export function readEnvironmentBlock(text: string): EnvironmentBlock | undefined {
  if (!text.includes(ENVIRONMENT_BEGIN) && !text.includes(ENVIRONMENT_END)) return undefined;
  const begin = text.indexOf(ENVIRONMENT_BEGIN);
  const end = text.indexOf(ENVIRONMENT_END);
  const bodyStart = begin + ENVIRONMENT_BEGIN.length;
  const openingNewline = text.startsWith("\r\n", bodyStart) ? 2 : 1;
  const closingNewline = text[end - 2] === "\r" ? 2 : 1;
  const suffix = text.slice(end + ENVIRONMENT_END.length);

  if (
    begin < 0 ||
    end < begin ||
    text.indexOf(ENVIRONMENT_BEGIN, begin + ENVIRONMENT_BEGIN.length) >= 0 ||
    text.indexOf(ENVIRONMENT_END, end + ENVIRONMENT_END.length) >= 0 ||
    (begin > 0 && text[begin - 1] !== "\n") ||
    text[bodyStart + openingNewline - 1] !== "\n" ||
    text[end - 1] !== "\n" ||
    (suffix.length > 0 && !suffix.startsWith("\n") && !suffix.startsWith("\r\n"))
  )
    throw new Error("The Canopy markers are incomplete or duplicated. Repair the markers before syncing.");

  return {
    before: text.slice(0, begin),
    content: text.slice(bodyStart + openingNewline, end - closingNewline).replaceAll("\r\n", "\n"),
    after: text.slice(end + ENVIRONMENT_END.length),
  };
}
