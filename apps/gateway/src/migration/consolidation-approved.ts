import { Schema } from "effect";
import type { ApprovedConsolidationSecret } from "./consolidation-types.ts";
import { CutoverError } from "./cutover-files.ts";
import { cutoverDigest } from "./cutover-protocol.ts";

const decodeSecrets = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: cutoverDigest, value: Schema.String }))),
  { onExcessProperty: "error" },
);

export function parseApprovedSecrets(payload: string): readonly ApprovedConsolidationSecret[] {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });

    return decodeSecrets(payload).map(({ id, value }) => {
      const bytes = Buffer.from(value, "base64");

      if (bytes.toString("base64") !== value) throw new Error();

      return { id, plaintext: decoder.decode(bytes) };
    });
  } catch {
    throw new CutoverError("The approved secret values could not be read.");
  }
}
