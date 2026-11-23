import type { LogSource } from "./limits.ts";

const stages = "discovery|registration|authorization|state";
const status = "0|[1-5][0-9]{2}";
const startFailed = new RegExp(`^connectors: oauth start failed stage (${stages}) status (${status})$`);

const startFailedRecord = new RegExp(
  `^\\{"at":\\d{1,16},"source":"gateway","event":"connector_oauth_start_failed","legacy":(?:true|false),"stage":"(?:${stages})","status":(?:${status})\\}\\n$`,
);

export function connectorEvent(message: string, source: LogSource) {
  if (source !== "gateway") return undefined;
  const failure = startFailed.exec(message);

  return failure ? { event: "connector_oauth_start_failed", stage: failure[1], status: Number(failure[2]) } : undefined;
}

export function verifiedConnectorRecord(line: string, source: LogSource) {
  return source === "gateway" && startFailedRecord.test(line);
}
