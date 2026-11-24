export const botReactionOptions = [
  { emoji: "👍", label: "Thumbs up" },
  { emoji: "❤️", label: "Heart" },
  { emoji: "😂", label: "Laugh" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "👀", label: "Eyes" },
  { emoji: "🙏", label: "Thanks" },
] as const;

export function isBotReactionEmoji(value: string): value is (typeof botReactionOptions)[number]["emoji"] {
  return botReactionOptions.some(({ emoji }) => emoji === value);
}
