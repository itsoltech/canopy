import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildVersion } from "./scripts/build-version.ts";
import { retainImmutable } from "./scripts/release-assets.ts";

const out = process.env["BUILD_DIR"] || "build";
const node = adapter({ out });
const version = process.env["WEB_BUILD_VERSION"] ??= buildVersion();

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Runes everywhere in this app (libraries keep their own mode).
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
      },
      version: { name: version, pollInterval: 60_000 },
      adapter: {
        ...node,
        async adapt(builder) {
          const previous = JSON.parse(process.env["WEB_PREVIOUS_RELEASES"] ?? "[]") as string[];
          const own = retainImmutable(builder.getClientDirectory(), previous);
          await node.adapt(builder);
          writeFileSync(join(out, "immutable-files.json"), JSON.stringify(own));
        },
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
});
