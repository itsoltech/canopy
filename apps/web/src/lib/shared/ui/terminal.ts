/** Shell words for display only; never evaluate a command to derive its title. */
function words(command: string): string[] {
  const result: string[] = [];

  let word = "",
    quote = "",
    started = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (char === "\\" && quote !== "'" && i + 1 < command.length && (!quote || /[\\"$`\n]/.test(command[i + 1]!))) {
      word += command[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) result.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }

  if (started) result.push(word);

  return result;
}

export function terminalTitle(command: string, description = ""): string {
  const short = (value: string) => (value.length > 64 ? `${value.slice(0, 61)}…` : value);

  if (
    description.trim() &&
    description.trim() !== command.trim() &&
    !/^(?:\/?\S*\/)?(?:ba|z|da)?sh\s/.test(description.trim())
  ) {
    return short(description.trim().split("\n")[0]!);
  }

  let args = words(command);

  for (let depth = 0; depth < 5; depth++) {
    const program = args[0]?.split("/").at(-1);
    const shellCommand = args.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));

    if (!program || !/^(?:bash|sh|zsh|dash|ksh)$/.test(program) || shellCommand < 0 || !args[shellCommand + 1]) break;
    args = words(args[shellCommand + 1]!);
  }

  const program = args.shift()?.split("/").at(-1) || "Background task";
  const arg = args.find((value) => !/^(?:-[uil]|--login)$/.test(value));

  return short(`${program}${arg ? ` ${arg}` : ""}${args.length > (arg ? 1 : 0) ? " …" : ""}`);
}

/** Use the remote path's home, never the browser/host machine's home. */
export function terminalCwd(cwd: string, max = 42): string {
  const home = cwd.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/)?.[0];
  const path = home ? `~${cwd.slice(home.length)}` : cwd;

  if (path.length <= max) return path;
  const left = Math.max(1, Math.floor((max - 1) / 2));

  return `${path.slice(0, left)}…${path.slice(-(max - left - 1))}`;
}
