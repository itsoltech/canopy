import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwind from "@tailwindcss/vite";
import { build, type InlineConfig } from "vite";
import { bundledNotices, mergeNotices, releaseNotices } from "../../../scripts/open-source-licenses.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = new URL("../src/lib/features/files/mobile-preview/", import.meta.url);
const [target, noticePath] = process.argv.slice(2);
const typescript = new Bun.Transpiler({ loader: "ts" });

const config: InlineConfig = {
  root,
  publicDir: false,
  configFile: false,
  // This standalone entry does not run SvelteKit or use its generated tsconfig.
  oxc: false,
  logLevel: "warn",
};

async function bundle(options: InlineConfig) {
  const result = await build({ ...config, ...options });

  const chunks = (Array.isArray(result) ? result : [result]).flatMap((build) =>
    "output" in build ? build.output : [],
  );

  const script = chunks.find((chunk) => chunk.type === "chunk");
  const css = chunks.filter((chunk) => chunk.type === "asset").find((asset) => asset.fileName.endsWith(".css"));

  const imports = [...(script?.imports ?? []), ...(script?.dynamicImports ?? [])].filter(
    (file) => file !== script?.fileName,
  );

  if (!script || imports.length || chunks.length !== (css ? 2 : 1))
    throw new Error(
      `Expected a self-contained offline Markdown bundle, got ${chunks.map((chunk) => chunk.fileName).join(", ")} with imports ${imports.join(", ")}`,
    );

  // Keep closing tag sequences in JS string and regex literals away from the HTML parser.
  const js = script.code.trim().replace(/<\/script|<!--/gi, (sequence) => `\\x3c${sequence.slice(1)}`);
  const style = css?.source.toString() ?? "";

  if (/<\/style/i.test(style)) throw new Error("The Markdown CSS contains an HTML closing tag.");

  return {
    js,
    hash: createHash("sha256").update(js).digest("base64"),
    // Supported WebViews use the WOFF2 fonts. Vite inlines the other variants as well, so drop those fallbacks.
    css: style.replace(/,url\(data:[^)]*\)\s*format\("(?:woff|truetype)"\)/g, ""),
    notices: bundledNotices([...Object.keys(script.modules), ...(css?.originalFileNames ?? [])]),
  };
}

if (!target || !noticePath) throw new Error("Pass destinations for the mobile Markdown bundle and license notices.");

const preview = await bundle({
  resolve: {
    alias: { "#lib/shared/ui/markdown/mermaid-loader.ts": fileURLToPath(new URL("mermaid-loader.ts", source)) },
  },
  plugins: [
    {
      name: "strip-svelte-module-types",
      enforce: "pre",
      transform: { filter: { id: /\.svelte\.ts$/ }, handler: (code) => typescript.transformSync(code) },
    },
    svelte({ configFile: false, compilerOptions: { runes: true } }),
    tailwind(),
  ],
  build: {
    write: false,
    target: ["chrome105", "safari16.4"],
    assetsInlineLimit: () => true,
    modulePreload: false,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      tsconfig: false,
      input: fileURLToPath(new URL("main.ts", source)),
      output: { format: "es", codeSplitting: false },
    },
  },
});

const mermaid = await bundle({
  build: {
    write: false,
    target: ["chrome105", "safari16.4"],
    chunkSizeWarningLimit: 9000,
    lib: {
      name: "CanopyMarkdownMermaid",
      entry: fileURLToPath(new URL("mermaid-entry.ts", source)),
      formats: ["iife"],
    },
    rolldownOptions: { tsconfig: false, output: { exports: "default" } },
  },
});

await writeFile(
  target,
  JSON.stringify({
    js: preview.js,
    css: preview.css,
    hash: preview.hash,
    mermaid: mermaid.js,
    mermaidHash: mermaid.hash,
  }),
);

await writeFile(noticePath, JSON.stringify(mergeNotices(releaseNotices("mobile"), preview.notices, mermaid.notices)));
