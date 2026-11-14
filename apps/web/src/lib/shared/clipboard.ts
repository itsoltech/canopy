import { toast } from "./ui/toast.svelte.ts";

/** Copies text and confirms with a toast; a denied clipboard says so instead of failing silently. */
export async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied");
  } catch {
    toast("Copying is not allowed here", { tone: "error" });
  }
}
