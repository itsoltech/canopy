import { LOG_LIMITS, type LogSource } from "./limits.ts";

const record =
  /^\{"at":\d{1,16},"source":"(desktop|gateway|worker|postgres|web|initdb)","event":"(?:process_started|process_stopped|process_restarting|migration_applied|link_changed|health_check|diagnostics_saved|startup_recovery|postgres_status|worker_events_not_stored|worker_events_dropped|worker_events_quarantined|worker_events_deferred)","legacy":(?:true|false)\}\n$/;

/** Defence in depth for authenticated source adapters: never archive arbitrary payloads or unknown JSON. */
export async function* verifiedLogChunks(input: AsyncIterable<Uint8Array>, source: LogSource, omitted: () => void) {
  let pending = Buffer.alloc(0);
  let dropping = false;
  let output = Buffer.alloc(LOG_LIMITS.chunk);
  let used = 0;

  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    let start = 0;

    for (let index = 0; index <= bytes.length; index++) {
      if (index < bytes.length && bytes[index] !== 10) continue;
      const end = index < bytes.length ? index + 1 : index;
      const part = bytes.subarray(start, end);

      if (!dropping && pending.length + part.length <= LOG_LIMITS.line) pending = Buffer.concat([pending, part]);
      else {
        dropping = true;
        pending = Buffer.alloc(0);
      }

      if (index < bytes.length) {
        if (!dropping && record.exec(pending.toString("utf8"))?.[1] === source) {
          if (used + pending.length > output.length) {
            yield output.subarray(0, used);
            output = Buffer.alloc(LOG_LIMITS.chunk);
            used = 0;
          }

          pending.copy(output, used);
          used += pending.length;
        } else omitted();
        pending = Buffer.alloc(0);
        dropping = false;
      }

      start = end;
    }
  }

  if (pending.length || dropping) omitted();

  if (used) yield output.subarray(0, used);
}
