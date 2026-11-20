import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersion } from "./scripts/build-version.ts";
import { retainImmutable, stringList } from "./scripts/release-assets.ts";

const out = process.env["BUILD_DIR"] || "build";
const node = adapter({ out });
const version = (process.env["WEB_BUILD_VERSION"] ??= buildVersion());

// The Canopy version (scripts/version.ts, docs/release.md), shown in Settings and by /api/health.
const canopyVersion = process.env["CANOPY_VERSION"] || "0.0.0-dev";

export default defineConfig({
  worker: { format: "es" },
  plugins: [
    tailwindcss(),
    {
      name: "canopy-standalone-web",
      apply: "build",
      applyToEnvironment: (environment) => environment.name === "ssr",
      buildStart() {
        this.emitFile({
          type: "chunk",
          id: fileURLToPath(new URL("./scripts/standalone.ts", import.meta.url)),
          fileName: "standalone-http.js",
          preserveSignature: "strict",
        });
      },
    },
    sveltekit({
      csp: { directives: { "frame-ancestors": ["none"] } },
      compilerOptions: {
        // Runes everywhere in this app (libraries keep their own mode).
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
      },
      version: { name: version, pollInterval: 60_000 },
      adapter: {
        ...node,
        async adapt(builder) {
          const previous = stringList(process.env["WEB_PREVIOUS_RELEASES"] ?? "[]");
          const own = retainImmutable(builder.getClientDirectory(), previous);
          await node.adapt(builder);

          if (!existsSync(join(out, "server/standalone-http.js"))) throw new Error("Missing standalone web listener");
          writeFileSync(
            join(out, "index.js"),
            [
              'import { startStandaloneWeb } from "./server/standalone-http.js";',
              'export const { host, path, port, server } = await startStandaloneWeb(() => import("./handler.js"));',
              "",
            ].join("\n"),
          );
          writeFileSync(join(out, "immutable-files.json"), JSON.stringify(own));
        },
      },
    }),
  ],
  define: { "process.env.CANOPY_VERSION": JSON.stringify(canopyVersion) },
  server: { port: 5173, strictPort: true, cors: false, headers: { "X-Frame-Options": "DENY" } },
  preview: { cors: false },
});
