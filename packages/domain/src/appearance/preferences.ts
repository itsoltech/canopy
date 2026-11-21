import { ui } from "@canopy/contracts";

export const colorSchemePreference = {
  id: "appearance.color_scheme",
  field: "colorScheme",
  group: "Colors",
  label: "Color scheme",
  description: "Follow the system or use a fixed light or dark palette.",
  keywords: "appearance theme display mode light dark colour",
  defaultChoice: "system",
  choices: {
    system: { label: "System", value: ui.ColorScheme.SYSTEM },
    light: { label: "Light", value: ui.ColorScheme.LIGHT },
    dark: { label: "Dark", value: ui.ColorScheme.DARK },
  },
} as const;

export const threadWidthPreference = {
  id: "appearance.thread_width",
  field: "chatWidth",
  group: "Interface",
  label: "Thread width",
  description: "Set the width of threads and their message boxes.",
  keywords: "appearance chat layout composer display wide narrow comfortable full",
  defaultChoice: "comfortable",
  choices: {
    comfortable: { label: "Comfortable", value: ui.ChatWidth.COMFORTABLE },
    wide: { label: "Wide", value: ui.ChatWidth.WIDE },
    full: { label: "Full width", value: ui.ChatWidth.FULL },
  },
} as const;

export function appearanceChoiceKey<K extends string>(
  choices: Record<K, { value: number }>,
  value: number | undefined,
  fallback: NoInfer<K>,
): K {
  for (const key in choices) if (choices[key].value === value) return key;

  return fallback;
}
