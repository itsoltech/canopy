import type { LanguageRegistration } from "@shikijs/primitive";

/**
 * Languages code blocks are highlighted in, each a grammar loaded on first use (its own chunk; a grammar
 * that embeds others, like svelte or html, brings them along). Anything else shows as plain text.
 */
export const grammars = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  elixir: () => import("@shikijs/langs/elixir"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  haskell: () => import("@shikijs/langs/haskell"),
  hcl: () => import("@shikijs/langs/hcl"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  nix: () => import("@shikijs/langs/nix"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  proto: () => import("@shikijs/langs/proto"),
  python: () => import("@shikijs/langs/python"),
  r: () => import("@shikijs/langs/r"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  scss: () => import("@shikijs/langs/scss"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  terraform: () => import("@shikijs/langs/terraform"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
} satisfies Record<string, () => Promise<{ default: LanguageRegistration[] }>>;

export type LanguageId = keyof typeof grammars;

/** Fence tags and file extensions that name a grammar by another word. */
const aliases = new Map<string, LanguageId>([
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["h", "c"],
  ["hh", "cpp"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["c#", "csharp"],
  ["cs", "csharp"],
  ["dockerfile", "docker"],
  ["containerfile", "docker"],
  ["env", "dotenv"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["golang", "go"],
  ["gql", "graphql"],
  ["hs", "haskell"],
  ["htm", "html"],
  ["xhtml", "html"],
  ["cfg", "ini"],
  ["conf", "ini"],
  ["properties", "ini"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["node", "javascript"],
  ["json5", "jsonc"],
  ["jsonl", "json"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["makefile", "make"],
  ["mk", "make"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["ps1", "powershell"],
  ["ps", "powershell"],
  ["pwsh", "powershell"],
  ["protobuf", "proto"],
  ["py", "python"],
  ["py3", "python"],
  ["python3", "python"],
  ["pyi", "python"],
  ["rb", "ruby"],
  ["gemfile", "ruby"],
  ["rs", "rust"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["zsh", "shellscript"],
  ["shell", "shellscript"],
  ["console", "shellscript"],
  ["fish", "shellscript"],
  ["ksh", "shellscript"],
  ["bashrc", "shellscript"],
  ["zshrc", "shellscript"],
  ["tf", "terraform"],
  ["tfvars", "terraform"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["patch", "diff"],
  ["svg", "xml"],
  ["plist", "xml"],
  ["xsd", "xml"],
  ["yml", "yaml"],
]);

/**
 * The grammar a fence's info string asks for (`ts`, `TypeScript`, `language-ts`, `py title="x"`), or
 * undefined when there is none we know: the block stays plain.
 */
export function languageOf(info: string | undefined): LanguageId | undefined {
  const word = info
    ?.trim()
    .split(/[\s{,]/, 1)[0]
    ?.toLowerCase()
    .replace(/^(language-|\.)/, "");

  if (!word) return undefined;

  if (Object.hasOwn(grammars, word)) return word as LanguageId;

  return aliases.get(word);
}

/** The grammar for a file path, by its extension or a well-known file name (`Dockerfile`, `Makefile`). */
export function languageOfPath(path: string): LanguageId | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");

  return languageOf(dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, ""));
}

/** How each language is called in a picker. */
export const LANGUAGE_NAMES: Record<LanguageId, string> = {
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dart: "Dart",
  diff: "Diff",
  docker: "Dockerfile",
  dotenv: ".env",
  elixir: "Elixir",
  go: "Go",
  graphql: "GraphQL",
  haskell: "Haskell",
  hcl: "HCL",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSON with comments",
  jsx: "JSX",
  kotlin: "Kotlin",
  lua: "Lua",
  make: "Makefile",
  markdown: "Markdown",
  nix: "Nix",
  php: "PHP",
  powershell: "PowerShell",
  proto: "Protocol Buffers",
  python: "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scala: "Scala",
  scss: "SCSS",
  shellscript: "Shell",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  terraform: "Terraform",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  zig: "Zig",
};

/** The word a fence gets when a language is picked: the short tag people type, else the grammar's id. */
const FENCE_TAGS: Partial<Record<LanguageId, string>> = {
  csharp: "cs",
  docker: "dockerfile",
  dotenv: "env",
  javascript: "js",
  markdown: "md",
  powershell: "ps1",
  python: "py",
  ruby: "rb",
  rust: "rs",
  shellscript: "sh",
  typescript: "ts",
  yaml: "yml",
};

export const fenceTag = (id: LanguageId): string => FENCE_TAGS[id] ?? id;

/** Every language with the other words that name it (to search a picker by `py` or `golang`). */
export const LANGUAGES: ReadonlyArray<{
  readonly id: LanguageId;
  readonly name: string;
  readonly words: readonly string[];
}> = (Object.keys(grammars) as LanguageId[])
  .map((id) => ({
    id,
    name: LANGUAGE_NAMES[id],
    words: [id, ...[...aliases].flatMap(([word, language]) => (language === id ? [word] : []))],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
