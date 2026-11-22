export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function jsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function jsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

type JsonRead = { value: JsonValue } | { status: 400 | 408 | 413 };

export async function readJson(message: Request | Response, limit: number, deadline: AbortSignal): Promise<JsonRead> {
  const declaredSize = message.headers.get("content-length");

  if (declaredSize !== null && Number(declaredSize) > limit) {
    void message.body?.cancel().catch(() => undefined);

    return { status: 413 };
  }

  if (deadline.aborted) return { status: 408 };

  const reader = message.body?.getReader();

  if (!reader) return { status: 400 };

  const bytes = new Uint8Array(limit);
  let size = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);

  deadline.addEventListener("abort", cancel, { once: true });

  try {
    for (;;) {
      const part = await reader.read();

      if (deadline.aborted) return { status: 408 };

      if (part.done) break;

      if (size + part.value.byteLength > limit) return { status: 413 };

      bytes.set(part.value, size);
      size += part.value.byteLength;
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));

    // SAFETY: JSON.parse returns only JSON values. Callers still check their expected fields.
    return { value: JSON.parse(text) as JsonValue };
  } catch {
    return { status: deadline.aborted ? 408 : 400 };
  } finally {
    deadline.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
