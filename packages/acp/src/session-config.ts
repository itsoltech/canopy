import type { SelectValue, SessionConfig } from "./types.ts";

/** A session may group select values or use its own option id without a semantic category. */
export function sessionSelect(session: SessionConfig, category: string, fallbackId = category) {
  const options = session.configOptions;

  const option =
    options?.find((row) => row.type === "select" && row.category === category) ??
    options?.find((row) => row.id === fallbackId);

  if (option?.type !== "select") return undefined;

  return {
    id: option.id,
    currentValue: option.currentValue,
    options: option.options.flatMap((row): SelectValue[] => ("group" in row ? row.options : [row])),
  };
}
