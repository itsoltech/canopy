import { normalizeColor } from "@canopy/ui/mascot";

/** Ignore exactly one original name when editing; other duplicates still count. */
export function nameError(name: string, existingNames: readonly string[], originalName?: string): string | undefined {
  const key = (value: string) => value.trim().normalize("NFC").toLowerCase();
  const normalized = key(name);

  if (!normalized) return "Give your bot a name.";
  let skippedOriginal = false;

  const duplicate = existingNames.some((existing) => {
    if (!skippedOriginal && originalName !== undefined && key(existing) === key(originalName)) {
      skippedOriginal = true;

      return false;
    }

    return key(existing) === normalized;
  });

  return duplicate ? "A bot with this name already exists. Choose another name." : undefined;
}

export function appearanceError(
  draft: { name: string; color: string },
  existingNames: readonly string[],
  originalName?: string,
): string | undefined {
  return (
    nameError(draft.name, existingNames, originalName) ??
    (!normalizeColor(draft.color) ? "Enter a color as #RGB or #RRGGBB." : undefined)
  );
}

export { normalizeColor };

export { BotComposerSync, type BotDraftTransport } from "./bot-composer-sync.ts";
