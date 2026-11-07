import { extname } from "node:path";
import type { JsonValue } from "@canopy/domain";
import { decodeJson } from "../providers/json.ts";
import { maskJson, maskText, type Masker } from "./masking.ts";
import { lines, readRange, sourceStat, type SourceFile } from "./read.ts";

/**
 * Masked native copies (docs/import.md, "Kontynuacja"): what a resumed session sends to the model is masked like the
 * imported timeline. JSON lines and JSON files are masked value by value and keep their format (a line without a
 * secret stays byte for byte); other text files are masked as text. A session that cannot be masked that way (a line
 * that is not JSON) is not continued natively: UnsafeCopy, and the thread continues in a new one.
 */

export class UnsafeCopy extends Error {}

/** Companion files larger than this are left out of a copy. */
const MAX_COMPANION = 64 * 1024 ** 2;

function decoded(text: string): JsonValue {
  try {
    return decodeJson(JSON.parse(text));
  } catch {
    throw new UnsafeCopy("a record of the session is not valid JSON, so it can't be masked");
  }
}

function maskedJson(text: string, masker: Masker): string {
  let found = false;
  const masked = maskJson(decoded(text), masker, () => (found = true));

  return found ? JSON.stringify(masked) : text;
}

/** The JSON lines of a file up to `end` (a complete-line boundary), masked. */
export function* maskedLines(file: SourceFile, end: number, masker: Masker): Generator<string> {
  for (const line of lines(file, 0, end)) {
    if (line.text === "" && line.end - line.offset > 1)
      throw new UnsafeCopy("a record of the session is too long to mask");

    yield line.text.trim() ? `${maskedJson(line.text, masker)}\n` : `${line.text}\n`;
  }
}

/** A companion file, masked by its kind; undefined when it is left out (binary or too large). */
export function maskedFile(file: SourceFile, masker: Masker): Iterable<string> | undefined {
  const size = sourceStat(file).size;

  if (size > MAX_COMPANION) return undefined;
  const extension = extname(file.path);

  if (extension === ".jsonl") return maskedLines(file, size, masker);
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readRange(file, 0, size));
  } catch {
    return undefined;
  }

  return [extension === ".json" ? maskedJson(text, masker) : maskText(text, masker)];
}
