export const diagnosticsLogRanges = [
  { value: "1", label: "1 hour" },
  { value: "6", label: "6 hours" },
  { value: "24", label: "24 hours" },
];

const statuses = new Map<string, string>(
  Object.entries({
    waiting: "Waiting",
    collecting: "Collecting",
    done: "Done",
    partial: "Partial",
    truncated: "Truncated",
    offline: "Offline",
    timed_out: "Timed out",
    not_permitted: "Not permitted",
    unsupported: "Update needed",
    cancelled: "Cancelled",
    unavailable: "Unavailable",
    not_available: "Not available",
    omitted: "Omitted",
  }),
);

export const diagnosticsLogStatus = (status: string) => statuses.get(status) ?? "Unavailable";

export const diagnosticsLogBytes = (bytes: bigint) =>
  bytes < 1024n * 1024n ? `${Math.ceil(Number(bytes) / 1024)} KiB` : `${(Number(bytes) / 1048576).toFixed(1)} MiB`;
