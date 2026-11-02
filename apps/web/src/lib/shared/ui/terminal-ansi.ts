export interface TerminalToken {
  text: string;
  foreground?: string | undefined;
  background?: string | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
}

const palette = ["#71717a", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d8", "#a1a1aa", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#fafafa"];
function color(index: number): string | undefined {
  if (index < 16) return palette[index];
  if (index < 232) {
    const n = index - 16, levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[Math.floor(n / 36)]}, ${levels[Math.floor(n / 6) % 6]}, ${levels[n % 6]})`;
  }
  if (index <= 255) { const gray = 8 + (index - 232) * 10; return `rgb(${gray}, ${gray}, ${gray})`; }
  return undefined;
}

/** SGR only. OSC links/clipboard, cursor controls and incomplete escape sequences are discarded.
 * Text stays text (Svelte escapes it); no output is interpreted as HTML or CSS. */
export function terminalAnsi(output: string): TerminalToken[][] {
  const lines: TerminalToken[][] = [[]];
  let style: Omit<TerminalToken, "text"> = {};
  const append = (text: string) => {
    text.split("\n").forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1)!.push({ text: part, ...style });
    });
  };
  const controls = /(?:\x1b\[|\x9b)([0-?]*)([ -/]*)([@-~])|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|\x1b\[[^@-~]*$|\x1b[ -/]*[0-~]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
  let end = 0;
  for (const match of output.matchAll(controls)) {
    append(output.slice(end, match.index));
    end = match.index + match[0].length;
    if (match[3] !== "m" || match[2] || !/^[\d;]*$/.test(match[1] ?? "")) continue;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 22) { style.bold = false; style.dim = false; }
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code === 39) style.foreground = undefined;
      else if (code === 49) style.background = undefined;
      else if (code >= 30 && code <= 37) style.foreground = color(code - 30);
      else if (code >= 90 && code <= 97) style.foreground = color(code - 90 + 8);
      else if (code >= 40 && code <= 47) style.background = color(code - 40);
      else if (code >= 100 && code <= 107) style.background = color(code - 100 + 8);
      else if (code === 38 || code === 48) {
        const target = code === 38 ? "foreground" : "background";
        const mode = codes[++i];
        if (mode === 5) style[target] = color(codes[++i] ?? -1);
        else if (mode === 2) {
          const rgb = codes.slice(i + 1, i + 4); i += 3;
          if (rgb.length === 3 && rgb.every((n) => n >= 0 && n <= 255)) style[target] = `rgb(${rgb.join(", ")})`;
        }
      }
    }
  }
  append(output.slice(end));
  if (output.endsWith("\n")) lines.pop();
  return lines;
}

export const terminalPlainText = (output: string): string => terminalAnsi(output).map((line) => line.map((token) => token.text).join("")).join("\n") + (output.endsWith("\n") ? "\n" : "");
