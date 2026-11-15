import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "../format.ts";
import { STORAGE_CATEGORIES } from "./storage.ts";

export const storageHelp =
  "Current file sizes do not depend on the time range. Measurements exclude project and worktree files.";

export const storageTotalsHelp = "Component totals can overlap or refer to different computers.";

export const storageDatabaseHelp = "The file total excludes the database. The database may use another computer.";

export interface StorageComponent {
  id: string;
  name: string;
  kind: string;
  state: string;
  storage: ui.DiagnosticsStorage | undefined;
  ageUncertain: boolean;
}

/** Keep components separate: a worker need not share its gateway's physical computer. */
export function storageComponents(computer: ui.ComputerDiagnostics): StorageComponent[] {
  return [
    {
      id: "gateway",
      name: computer.storage?.component === "desktop" ? "Desktop" : "Gateway",
      kind: "",
      state: computer.status,
      storage: computer.storage,
      ageUncertain: computer.ageUncertain,
    },
    ...computer.links
      .filter((link) => link.kind === "worker")
      .map((link) => ({
        id: `worker:${link.targetId}`,
        name: link.name,
        kind: link.storage?.component === "desktop" ? "Desktop" : "Worker",
        state: computer.status === "online" ? (link.online ? "online" : "offline") : computer.status,
        storage: link.storage,
        ageUncertain: computer.ageUncertain,
      })),
  ];
}

const categoryNames: Record<(typeof STORAGE_CATEGORIES)[number], string> = {
  logs: "Logs",
  data: "Data",
  cache: "Cache",
  application: "Application",
  database: "Database",
};

const storageNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, useGrouping: false });

function storageBytes(bytes: bigint) {
  const value = Number(bytes);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));

  return `${storageNumber.format(value / 1024 ** index)} ${units[index]}`;
}

function missingStorage(state: string) {
  if (state === "not_permitted") return ["Not permitted", "Allow diagnostics access on this computer."];

  if (["offline", "stale"].includes(state))
    return [
      state === "offline" ? "Offline" : "Stale",
      "No saved storage measurement. Reconnect this computer to measure Canopy storage.",
    ];

  if (state === "loading") return ["Waiting for snapshot…", ""];

  return ["Update needed", "Update this computer to measure Canopy storage."];
}

/** Missing categories stay missing; a partial sample is a lower bound, never a complete total. */
export function storageDisplay(component: StorageComponent, now = Date.now()) {
  const { storage, state, ageUncertain } = component;
  const measured = storage?.status === "ready" || storage?.status === "partial";
  const partial = storage?.status === "partial";
  const sampleAgeMs = storage?.sampleAgeMs ?? 0;
  const sampledAtMs = storage?.sampledAtMs ? BigInt(Math.round(now - sampleAgeMs)) : 0n;
  const stale = state === "stale" || sampleAgeMs > 5 * 60_000;
  const lastKnown = measured && (state !== "online" || stale);
  const [missingStatus, missingMessage] = missingStorage(state);

  const status = !storage
    ? missingStatus
    : [
        partial ? "Partial" : "",
        storage.status === "measuring" ? "Measuring…" : "",
        storage.status === "unavailable" ? "Unavailable" : "",
        lastKnown ? `${state === "offline" ? "Offline" : "Stale"} · Last known data` : "",
      ]
        .filter(Boolean)
        .join(" · ");

  const gateway = storage?.component === "gateway";

  const categories: [string, string][] = measured
    ? STORAGE_CATEGORIES.filter((category) => !gateway || category !== "database").flatMap((category) => {
        const row = storage.categories.find((value) => value.category === category);

        return row ? [[categoryNames[category], `${partial ? "≥ " : ""}${storageBytes(row.bytes)}`]] : [];
      })
    : [];

  const total = measured
    ? storage.categories
        .filter((row) => !gateway || row.category !== "database")
        .reduce((sum, row) => sum + row.bytes, 0n)
    : undefined;

  const database = measured && gateway ? storage.categories.find((row) => row.category === "database") : undefined;
  const age = sampledAtMs > 0n ? formatRelative(timestampFromMs(Number(sampledAtMs)), now) : "";

  return {
    status,
    message: !storage
      ? missingMessage
      : partial
        ? "Some files are missing from this total. Canopy retries automatically."
        : storage.status === "unavailable"
          ? "Canopy could not measure these files. It retries automatically."
          : "",
    total: total === undefined ? "Not measured" : `${partial ? "At least " : ""}${storageBytes(total)}`,
    totalLabel: gateway ? "Canopy files" : "Total",
    database: database ? `${partial ? "≥ " : ""}${storageBytes(database.bytes)}` : "",
    note: storage?.component === "desktop" ? "Includes this app’s worker data." : "",
    categories,
    sampledAtMs,
    sampleAction: measured ? "Measured" : "Checked",
    showDate: sampledAtMs > 0n && sampleAgeMs >= 7 * 86_400_000,
    freshness: age ? `${measured ? "Measured" : "Checked"} ${age}${ageUncertain ? " · Age is approximate" : ""}` : "",
  };
}
