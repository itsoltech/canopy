import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { checkSkillPath } from "@canopy/domain/skill-artifact";
import { Code, ConnectError } from "@connectrpc/connect";

export function sourceInvalid(message: string): never {
  throw new ConnectError(message, Code.InvalidArgument);
}

/** Closed lexer: quoting groups arguments, never invokes a shell or expands any token. */
function tokens(command: string): string[] {
  if (!command.trim() || command.length > 4096 || command.includes("\0") || /[\n\r`$;&|<>\\]/.test(command))
    sourceInvalid("Paste a skills add command or an HTTPS repository reference without shell operators.");
  const parts = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s'"]+/g) ?? [];

  if (parts.join(" ").replaceAll(" ", "") !== command.replaceAll(/\s/g, ""))
    sourceInvalid("Use complete quotes around arguments.");

  return parts.map((p) => p.replace(/^(['"])(.*)\1$/, "$2"));
}

export function sourceReference(input: string) {
  let value = input.replace(/^github:/, "");
  let ref = "HEAD";
  let filter = "";
  const hash = value.indexOf("#");

  if (hash >= 0) {
    const fragment = value.slice(hash + 1).split("@");
    ref = decodeURIComponent(fragment[0] || "HEAD");
    filter = decodeURIComponent(fragment[1] ?? "");
    value = value.slice(0, hash);
  }

  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w-]+)|\/(.+))?$/);
  let path = "";

  if (shorthand) {
    value = `https://github.com/${shorthand[1]}/${shorthand[2]!.replace(/\.git$/, "")}.git`;
    filter ||= shorthand[3] ?? "";
    path = shorthand[4] ?? "";
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return sourceInvalid("Use owner/repo[/path] or an HTTPS git URL.");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    sourceInvalid("Source URLs require HTTPS without credentials, query parameters or fragments.");

  const segments = decodeURIComponent(url.pathname)
    .replace(/^\/+|\/+$/g, "")
    .split("/");

  if (url.hostname === "skills.sh") {
    if (segments.length !== 3) sourceInvalid("Use a skills.sh owner/repo/skill link.");
    filter = segments[2]!;
    url = new URL(`https://github.com/${segments[0]}/${segments[1]}.git`);
  } else if (url.hostname === "github.com") {
    if (segments.length < 2) sourceInvalid("Include the repository owner and name.");

    if (segments[2] === "tree") {
      ref = segments[3] ?? "";
      path = segments.slice(4).join("/");
    } else if (segments.length > 2) path = segments.slice(2).join("/");
    url = new URL(`https://github.com/${segments[0]}/${segments[1]!.replace(/\.git$/, "")}.git`);
  }

  if (path) checkSkillPath(path);

  if (!ref || ref.length > 200 || !/^[\w./-]+$/.test(ref) || ref.startsWith("-") || ref.includes(".."))
    sourceInvalid("Use a branch, tag or commit without revision operators.");

  return { source: create(ui.SkillSourceSchema, { url: url.href, ref, path }), filter };
}

export function parseSourceCommand(command: string) {
  const args = tokens(command);
  const notices: string[] = [];
  const harnesses: string[] = [];
  const names: string[] = [];
  let deviceHome = false;
  let fullDepth = false;

  if (["npx", "bunx", "pnpx"].includes(args[0] ?? "")) {
    args.shift();

    if (["-y", "--yes"].includes(args[0] ?? "")) args.shift();

    if (!/^skills(?:@[\w.-]+)?$/.test(args.shift() ?? "") || !["add", "a", "install", "i"].includes(args.shift() ?? ""))
      sourceInvalid("Supported commands: npx skills add …, bunx skills add … or a repository reference.");
  } else if (args[0] === "skills") {
    args.shift();

    if (args.shift() !== "add") sourceInvalid("Use skills add.");
  }

  const input = args.shift();

  if (!input || input.startsWith("-")) sourceInvalid("Include one repository source before its flags.");

  while (args.length) {
    const flag = args.shift();

    if (["-s", "--skill", "-a", "--agent"].includes(flag ?? "")) {
      const values: string[] = [];

      while (args.length && !args[0]!.startsWith("-")) values.push(args.shift()!);

      if (!values.length) sourceInvalid("Skill and agent flags require values.");

      if (flag === "-s" || flag === "--skill") names.push(...values);
      else harnesses.push(...values);
    } else if (flag === "-g" || flag === "--global") deviceHome = true;
    else if (flag === "--full-depth") fullDepth = true;
    else if (["-y", "--yes", "--copy", "--all", "-l", "--list"].includes(flag ?? ""))
      notices.push(`${flag} is a CLI option; Canopy still requires explicit Add and sync confirmation.`);
    else sourceInvalid("Unsupported flag. Use --skill, --agent, --global, --copy, --yes or --full-depth.");
  }

  if (harnesses.some((h) => !["claude-code", "claude", "codex", "grok", "*"].includes(h)))
    sourceInvalid("Canopy supports Claude, Codex and Grok destinations.");
  const parsed = sourceReference(input);

  if (parsed.filter) names.push(parsed.filter);

  return {
    ...parsed,
    names,
    fullDepth,
    deviceHome,
    harnesses:
      !harnesses.length || harnesses.includes("*")
        ? ["claude", "codex", "grok"]
        : [...new Set(harnesses.map((h) => (h === "claude-code" ? "claude" : h)))],
    notices,
  };
}
