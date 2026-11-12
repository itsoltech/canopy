import { createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { invalidCursor } from "./read-scope.ts";

const Cursor = Schema.Struct({
  binding: Schema.String,
  lane: Schema.Number,
  position: Schema.String,
  offset: Schema.Number,
  expires: Schema.Number,
});

/** Account token signs the cursor inside the gateway; only the signature leaves it. */
export function pickerCursor(token: string, binding: string, now: number, value: string) {
  const sign = (text: string) => createHmac("sha256", token).update(text).digest();
  let lane = 0;
  let position = "";
  let offset = 0;

  if (value) {
    try {
      if (value.length > 4096) throw invalidCursor();
      const [text = "", signature = ""] = value.split(".");
      const actual = Buffer.from(signature, "base64url");
      const expected = sign(text);

      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
      const parsed = Schema.decodeUnknownSync(Cursor)(JSON.parse(Buffer.from(text, "base64url").toString()));

      if (
        parsed.binding !== binding ||
        parsed.expires <= now ||
        ![0, 1, 2].includes(parsed.lane) ||
        !Number.isInteger(parsed.offset) ||
        parsed.offset < 0 ||
        parsed.offset > 29
      )
        throw invalidCursor();
      lane = parsed.lane;
      position = parsed.position;
      offset = parsed.offset;
    } catch {
      throw invalidCursor();
    }
  }

  return {
    lane,
    position,
    offset,
    next: (nextLane: number, nextPosition: string, nextOffset: number) => {
      if (nextLane > 2) return "";

      const text = Buffer.from(
        JSON.stringify({ binding, lane: nextLane, position: nextPosition, offset: nextOffset, expires: now + 900_000 }),
      ).toString("base64url");

      return `${text}.${sign(text).toString("base64url")}`;
    },
  };
}
