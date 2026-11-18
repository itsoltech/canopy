import { toast } from "./ui/toast.svelte.ts";

/** Copies text and confirms with a toast; a denied clipboard says so instead of failing silently. */
export async function copyText(value: string | Promise<string>): Promise<void> {
  try {
    const clipboard = navigator.clipboard;

    if (!(value instanceof Promise)) await clipboard.writeText(value);
    else if (clipboard?.write && typeof ClipboardItem !== "undefined") {
      // Start the clipboard write during the click, before the text is available in Safari.
      const data = value.then((text) => new Blob([text], { type: "text/plain" }));
      await Promise.all([data, clipboard.write([new ClipboardItem({ "text/plain": data })])]);
    } else await clipboard.writeText(await value);
    toast("Copied");
  } catch {
    let message = "Could not copy. Check clipboard access, then try again.";

    try {
      await value;
    } catch (cause) {
      if (cause instanceof Error) message = cause.message;
    }

    toast(message, { tone: "error" });
  }
}
