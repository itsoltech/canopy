import { fileIconPaths } from "./file-icon-paths.ts";
import type { IconName } from "./icons.ts";

/**
 * A file's type glyph: a language or tool mark (24-unit filled path) in its colour, or a kit icon for generic kinds
 * (images, archives, tables). Colours come in pairs that keep the mark legible on the light and dark surfaces.
 */
export interface FileGlyph {
  readonly path?: string;
  readonly icon: IconName;
  /** Colours on light and dark surfaces; empty for the muted default. */
  readonly light: string;
  readonly dark: string;
}

const mark = (path: string, light: string, dark = light): FileGlyph => ({
  path,
  icon: "document-text",
  light,
  dark,
});

const kit = (icon: IconName, light = "", dark = light): FileGlyph => ({ icon, light, dark });

const glyphs = {
  astro: mark(fileIconPaths.astro, "#d83b00", "#ff7e33"),
  bun: mark(fileIconPaths.bun, "#57534e", "#fbf0df"),
  c: mark(fileIconPaths.c, "#3b5e9f", "#599eff"),
  clojure: mark(fileIconPaths.clojure, "#4a6fc2", "#8aa8f0"),
  cmake: mark(fileIconPaths.cmake, "#064f8c", "#6aa3d8"),
  cpp: mark(fileIconPaths.cpp, "#c4335f", "#f34b7d"),
  css: mark(fileIconPaths.css, "#663399", "#a97fe0"),
  dart: mark(fileIconPaths.dart, "#0175c2", "#40c4ff"),
  deno: mark(fileIconPaths.deno, "#3f3f46", "#d4d4d8"),
  docker: mark(fileIconPaths.docker, "#1d63ed", "#5aa2f0"),
  dotnet: mark(fileIconPaths.dotnet, "#512bd4", "#9b7bf0"),
  editorconfig: mark(fileIconPaths.editorconfig, "#52525b", "#a1a1aa"),
  elixir: mark(fileIconPaths.elixir, "#4b275f", "#b48ad0"),
  elm: mark(fileIconPaths.elm, "#1293d8", "#60b5cc"),
  env: mark(fileIconPaths.env, "#a68c00", "#ecd53f"),
  erlang: mark(fileIconPaths.erlang, "#a90533", "#e04869"),
  eslint: mark(fileIconPaths.eslint, "#4b32c3", "#8f80f2"),
  fsharp: mark(fileIconPaths.fsharp, "#378bba", "#5fb3d9"),
  git: mark(fileIconPaths.git, "#c2410c", "#f1502f"),
  githubActions: mark(fileIconPaths.githubActions, "#1f6feb", "#58a6ff"),
  gleam: mark(fileIconPaths.gleam, "#c026d3", "#ffaff3"),
  go: mark(fileIconPaths.go, "#00758d", "#00add8"),
  graphql: mark(fileIconPaths.graphql, "#c4007f", "#f52ab4"),
  haskell: mark(fileIconPaths.haskell, "#5e5086", "#a99bd6"),
  html: mark(fileIconPaths.html, "#d1401c", "#f0663a"),
  java: mark(fileIconPaths.java, "#b07219", "#e8a34a"),
  javascript: mark(fileIconPaths.javascript, "#a88c00", "#f0db4f"),
  julia: mark(fileIconPaths.julia, "#9558b2", "#c08be0"),
  jupyter: mark(fileIconPaths.jupyter, "#c2410c", "#f37626"),
  kotlin: mark(fileIconPaths.kotlin, "#7f52ff", "#a881ff"),
  latex: mark(fileIconPaths.latex, "#007a7a", "#3dbaba"),
  lua: mark(fileIconPaths.lua, "#2c2d72", "#6f9fd8"),
  markdown: mark(fileIconPaths.markdown, "#52525b", "#a1a1aa"),
  nim: mark(fileIconPaths.nim, "#a48c00", "#ffe953"),
  nix: mark(fileIconPaths.nix, "#5277c3", "#7ebae4"),
  node: mark(fileIconPaths.node, "#3f7f34", "#6cc24a"),
  npm: mark(fileIconPaths.npm, "#cb3837", "#e05d5c"),
  ocaml: mark(fileIconPaths.ocaml, "#c25200", "#ef7a08"),
  perl: mark(fileIconPaths.perl, "#39457e", "#8f9be0"),
  php: mark(fileIconPaths.php, "#4f5b93", "#9aa5dc"),
  pnpm: mark(fileIconPaths.pnpm, "#c46a00", "#f69220"),
  postgres: mark(fileIconPaths.postgres, "#336791", "#6aa0d6"),
  prettier: mark(fileIconPaths.prettier, "#1a2b34", "#c596c7"),
  python: mark(fileIconPaths.python, "#3572a5", "#ffd43b"),
  r: mark(fileIconPaths.r, "#276dc3", "#5c9ae6"),
  react: mark(fileIconPaths.react, "#087ea4", "#61dafb"),
  ruby: mark(fileIconPaths.ruby, "#c3291f", "#f0564a"),
  rust: mark(fileIconPaths.rust, "#a2400c", "#dea584"),
  sass: mark(fileIconPaths.sass, "#bf4080", "#f55385"),
  scala: mark(fileIconPaths.scala, "#c42b28", "#e65a4a"),
  shell: mark(fileIconPaths.shell, "#3f7e2b", "#89e051"),
  sqlite: mark(fileIconPaths.sqlite, "#0f6eb0", "#6cb5e8"),
  svelte: mark(fileIconPaths.svelte, "#e63900", "#ff6a3d"),
  svg: mark(fileIconPaths.svg, "#b7791f", "#ffb13b"),
  swift: mark(fileIconPaths.swift, "#d9480f", "#f05138"),
  tailwind: mark(fileIconPaths.tailwind, "#0891b2", "#38bdf8"),
  terraform: mark(fileIconPaths.terraform, "#7b42bc", "#a77bf3"),
  toml: mark(fileIconPaths.toml, "#9c4221", "#e8a17a"),
  typescript: mark(fileIconPaths.typescript, "#3178c6", "#519aba"),
  vite: mark(fileIconPaths.vite, "#646cff", "#9499ff"),
  vue: mark(fileIconPaths.vue, "#2f9768", "#41b883"),
  wasm: mark(fileIconPaths.wasm, "#654ff0", "#8b7bf5"),
  xml: mark(fileIconPaths.xml, "#b45309", "#e37933"),
  yaml: mark(fileIconPaths.yaml, "#b91c1c", "#f87171"),
  yarn: mark(fileIconPaths.yarn, "#2c8ebb", "#5ab4dd"),
  zig: mark(fileIconPaths.zig, "#b06e00", "#f7a41d"),
  archive: kit("archive-box", "#a16207", "#d6a356"),
  audio: kit("musical-note", "#be185d", "#f472b6"),
  config: kit("cog-6-tooth"),
  image: kit("photo", "#7c3aed", "#a78bfa"),
  lock: kit("lock-closed"),
  pdf: kit("file-pdf", "#c81e1e", "#f87171"),
  table: kit("table-cells", "#15803d", "#4ade80"),
  terminal: kit("command-line"),
  json: kit("code-bracket", "#a16207", "#e5c07b"),
  code: kit("code-bracket"),
  text: kit("document-text"),
} satisfies Record<string, FileGlyph>;

type GlyphId = keyof typeof glyphs;

const group = (id: GlyphId, keys: string): [string, GlyphId][] => keys.split(" ").map((key) => [key, id]);

/** Whole file names, matched before extensions (lower case). */
const names = new Map<string, GlyphId>([
  ...group("node", "package.json"),
  ...group("npm", "package-lock.json .npmrc"),
  ...group("bun", "bun.lock bun.lockb bunfig.toml"),
  ...group("pnpm", "pnpm-lock.yaml pnpm-workspace.yaml"),
  ...group("yarn", "yarn.lock .yarnrc .yarnrc.yml"),
  ...group("deno", "deno.json deno.jsonc deno.lock"),
  ...group("typescript", "tsconfig.json jsconfig.json"),
  ...group("rust", "cargo.toml cargo.lock rust-toolchain rust-toolchain.toml"),
  ...group("go", "go.mod go.sum go.work"),
  ...group("nix", "flake.lock"),
  ...group("docker", "dockerfile containerfile .dockerignore compose.yaml compose.yml docker-compose.yml"),
  ...group("git", ".gitignore .gitattributes .gitmodules .gitkeep"),
  ...group("editorconfig", ".editorconfig"),
  ...group("prettier", ".prettierrc .prettierignore"),
  ...group("env", ".env"),
  ...group("terminal", "makefile justfile"),
  ...group("shell", ".bashrc .bash_profile .zshrc .zprofile .profile"),
  ...group("cmake", "cmakelists.txt"),
  ...group("python", "requirements.txt pyproject.toml pipfile"),
  ...group("ruby", "gemfile gemfile.lock rakefile"),
]);

/** Name prefixes for tool configs such as `vite.config.ts`; checked after whole names. */
const prefixes: [string, GlyphId][] = [
  ["tsconfig.", "typescript"],
  ["vite.config.", "vite"],
  ["vitest.config.", "vite"],
  ["tailwind.config.", "tailwind"],
  ["eslint.config.", "eslint"],
  [".eslintrc", "eslint"],
  ["prettier.config.", "prettier"],
  [".prettierrc.", "prettier"],
  ["svelte.config.", "svelte"],
  ["dockerfile.", "docker"],
  [".env.", "env"],
];

const extensions = new Map<string, GlyphId>([
  ...group("typescript", "ts mts cts"),
  ...group("javascript", "js mjs cjs"),
  ...group("react", "tsx jsx"),
  ...group("svelte", "svelte"),
  ...group("vue", "vue"),
  ...group("astro", "astro"),
  ...group("rust", "rs"),
  ...group("go", "go"),
  ...group("python", "py pyi pyw"),
  ...group("jupyter", "ipynb"),
  ...group("ruby", "rb erb gemspec"),
  ...group("php", "php"),
  ...group("swift", "swift"),
  ...group("kotlin", "kt kts"),
  ...group("java", "java jar class"),
  ...group("scala", "scala sc sbt"),
  ...group("clojure", "clj cljs cljc edn"),
  ...group("c", "c h"),
  ...group("cpp", "cpp cc cxx hpp hh hxx"),
  ...group("dotnet", "cs csproj sln"),
  ...group("fsharp", "fs fsi fsx"),
  ...group("dart", "dart"),
  ...group("elixir", "ex exs heex"),
  ...group("erlang", "erl hrl"),
  ...group("gleam", "gleam"),
  ...group("elm", "elm"),
  ...group("haskell", "hs lhs"),
  ...group("ocaml", "ml mli"),
  ...group("julia", "jl"),
  ...group("r", "r rmd"),
  ...group("perl", "pl pm"),
  ...group("lua", "lua luau"),
  ...group("nim", "nim nims"),
  ...group("zig", "zig zon"),
  ...group("wasm", "wasm wat"),
  ...group("html", "html htm"),
  ...group("css", "css"),
  ...group("sass", "scss sass"),
  ...group("svg", "svg"),
  ...group("graphql", "graphql gql"),
  ...group("postgres", "sql"),
  ...group("sqlite", "db sqlite sqlite3"),
  ...group("markdown", "md mdx markdown"),
  ...group("latex", "tex sty bib"),
  ...group("json", "json jsonc json5 jsonl"),
  ...group("yaml", "yaml yml"),
  ...group("toml", "toml"),
  ...group("xml", "xml plist xsd xsl"),
  ...group("nix", "nix"),
  ...group("terraform", "tf tfvars hcl"),
  ...group("shell", "sh bash zsh fish ksh"),
  ...group("terminal", "ps1 bat cmd mk"),
  ...group("config", "ini cfg conf properties"),
  ...group("lock", "lock"),
  ...group("image", "png jpg jpeg gif webp avif bmp ico heic tif tiff"),
  ...group("pdf", "pdf"),
  ...group("table", "csv tsv xls xlsx ods"),
  ...group("audio", "mp3 wav flac ogg m4a aac"),
  ...group("archive", "zip tar gz tgz bz2 xz zst 7z rar"),
  ...group("code", "proto cmake vim el"),
  ...group("text", "txt log"),
]);

function glyphId(path: string): GlyphId {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const exact = names.get(name);

  if (exact) return exact;

  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return "githubActions";

  const prefix = prefixes.find(([start]) => name.startsWith(start));

  if (prefix) return prefix[1];
  const dot = name.lastIndexOf(".");

  return (dot > 0 && extensions.get(name.slice(dot + 1))) || "text";
}

/** The glyph for a file path: its whole name first, then tool config prefixes, then its extension. */
export const fileGlyph = (path: string): FileGlyph => glyphs[glyphId(path)];
