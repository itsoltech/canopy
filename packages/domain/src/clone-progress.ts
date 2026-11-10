import type { CloneProgress } from "@canopy/contracts";

export const CLONE_COMMAND_TIMEOUT_MS = 60 * 60_000 + 15_000;
export const CLONE_RPC_TIMEOUT_MS = 61 * 60_000;

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function size(bytes: number): string {
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)));

  return `${number.format(bytes / 1024 ** unit)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

/** Same phase/transfer label on web, desktop and mobile. */
export function cloneProgressLabel(progress: CloneProgress | undefined): string {
  return [
    progress?.phase || "Cloning…",
    progress?.percent === undefined ? "" : `${number.format(progress.percent)}%`,
    progress?.bytes === undefined ? "" : size(progress.bytes),
    progress?.bytesPerSecond === undefined ? "" : `${size(progress.bytesPerSecond)}/s`,
  ]
    .filter(Boolean)
    .join(" · ");
}
