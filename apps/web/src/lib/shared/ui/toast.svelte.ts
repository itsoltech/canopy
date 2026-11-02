import { duration } from "./motion.ts";

/**
 * Short confirmations that need no answer ("Copied"): `toast(text)` shows one in the app's `Toaster`
 * for a moment. Errors that need attention belong next to what failed, not here. With `action` (Undo) it
 * stays a little longer and carries one button; choosing it closes the toast.
 */
export type ToastTone = "success" | "info" | "error";

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: ToastTone;
  readonly action?: ToastAction | undefined;
  closing: boolean;
}

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

const HOLD_MS = 2000;
const HOLD_WITH_ACTION_MS = 6000;
let counter = 0;

export const toasts = $state<Toast[]>([]);

export function toast(text: string, { tone = "success", action }: { tone?: ToastTone; action?: ToastAction } = {}): void {
  const entry: Toast = { id: ++counter, text, tone, action, closing: false };
  // One at a time: a new confirmation replaces the previous one.
  for (const old of toasts) dismiss(old.id);
  toasts.push(entry);
  setTimeout(() => dismiss(entry.id), action ? HOLD_WITH_ACTION_MS : HOLD_MS);
}

/** Starts the exit (motion.css `.t-toast[data-closing]`, --duration-medium), then removes it. */
export function dismiss(id: number): void {
  const entry = toasts.find((t) => t.id === id);
  if (!entry || entry.closing) return;
  entry.closing = true;
  setTimeout(() => {
    const at = toasts.findIndex((t) => t.id === id);
    if (at >= 0) toasts.splice(at, 1);
  }, duration("medium"));
}
