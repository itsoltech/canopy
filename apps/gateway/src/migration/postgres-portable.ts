import { Buffer } from "node:buffer";

const embeddedAttributeVersion = /^ALTER TABLE ONLY [^;\r\n]+ ALTER COLUMN [^;\r\n]+ SET \(pg_attver=\d+\);\r?\n$/;

/** The embedded PostgreSQL distribution records pg_attver as an internal column option.
 * Ordinary PostgreSQL rejects that option. Keep COPY payloads byte-for-byte intact. */
export async function* portableRestoreSql(chunks: AsyncIterable<Uint8Array>) {
  let pending = Buffer.alloc(0);
  let longLine = false;
  let copying = false;

  for await (const chunk of chunks) {
    if (copying) {
      yield chunk;
      continue;
    }

    let part = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    while (part.length) {
      const newline = part.indexOf(10);
      const end = newline < 0 ? part.length : newline + 1;
      const next = part.subarray(0, end);
      part = part.subarray(end);

      if (longLine || pending.length + next.length > 4096) {
        if (pending.length) yield pending;
        yield next;
        pending = Buffer.alloc(0);
        longLine = newline < 0;
        continue;
      }

      pending = Buffer.concat([pending, next]);

      if (newline < 0) continue;
      const line = pending.toString("utf8");

      if (!embeddedAttributeVersion.test(line)) yield pending;
      pending = Buffer.alloc(0);

      if (/^COPY .* FROM stdin;\r?\n$/.test(line)) {
        copying = true;

        if (part.length) yield part;
        break;
      }
    }
  }

  if (pending.length) yield pending;
}
