import { Predicate } from "effect";
import type { JsonObject, JsonValue } from "@canopy/domain";

const heading = (key: string) => key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

function value(input: JsonValue | undefined, depth = 0): string {
  if (Predicate.isString(input)) return input;

  if (Predicate.isBoolean(input)) return input ? "Yes" : "No";

  if (input === null || input === undefined) return "None";

  if (Predicate.isNumber(input)) return String(input);

  if (depth >= 2) return "Additional nested details";

  if (Array.isArray(input))
    return input
      .slice(0, 16)
      .map((v) => value(v, depth + 1))
      .join(", ");

  return Object.entries(input)
    .slice(0, 16)
    .map(([k, v]) => `${heading(k)}: ${hidden(k) ? "Hidden value" : value(v, depth + 1)}`)
    .join("; ");
}

const hidden = (key: string) => /token|secret|password|authorization/i.test(key);

export function approvalFields(args: JsonObject): { label: string; value: string }[] {
  return Object.entries(args)
    .slice(0, 16)
    .map(([key, input]) => ({
      label: heading(key),
      value: hidden(key) ? "Hidden value" : value(input),
    }));
}
