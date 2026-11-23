import type { LogSource } from "./limits.ts";

const stages = "discovery|registration|authorization|state";
const status = "0|[1-5][0-9]{2}";
const network = "ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ETIMEDOUT|dns|timeout|transport";

const startFailed = new RegExp(
  `^connectors: oauth start failed stage (${stages}) status (${status})(?: network (${network}))?$`,
);

const refreshFailed = new RegExp(`^connectors: oauth refresh failed network (${network})$`);

const prefix = `^\\{"at":\\d{1,16},"source":"gateway"`;

const startFailedRecord = new RegExp(
  `${prefix},"event":"connector_oauth_start_failed","legacy":(?:true|false),"stage":"(?:${stages})","status":(?:${status})(?:,"network":"(?:${network})")?\\}\\n$`,
);

const refreshFailedRecord = new RegExp(
  `${prefix},"event":"connector_oauth_refresh_failed","legacy":(?:true|false),"network":"(?:${network})"\\}\\n$`,
);

export function connectorEvent(message: string, source: LogSource) {
  if (source !== "gateway") return undefined;
  const failure = startFailed.exec(message);

  if (failure)
    return {
      event: "connector_oauth_start_failed",
      stage: failure[1],
      status: Number(failure[2]),
      ...(failure[3] && { network: failure[3] }),
    };
  const refresh = refreshFailed.exec(message);

  return refresh ? { event: "connector_oauth_refresh_failed", network: refresh[1] } : undefined;
}

export function verifiedConnectorRecord(line: string, source: LogSource) {
  return source === "gateway" && (startFailedRecord.test(line) || refreshFailedRecord.test(line));
}
