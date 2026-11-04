/** Protobuf 64-bit fields are bigints, which JSON.stringify refuses; test replacers turn them into text. */
export function isBigInt(value: unknown): value is bigint {
  return typeof value === "bigint";
}
