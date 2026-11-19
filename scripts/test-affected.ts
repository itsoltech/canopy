import { $ } from "bun";

const base = process.argv[2];

if (!base) throw new Error("Usage: bun scripts/test-affected.ts <PR base commit>");

// The selector supplies only repository-owned Bun path filters for inputs outside the import graph.
const filters = (process.env["EXTRA_TESTS"] ?? "").split(" ").filter(Boolean);

if (filters.length) await $`${process.execPath} run check:tmp ${filters}`;

const exclusions = filters.flatMap((filter) =>
  filter === "mobile"
    ? ["--path-ignore-patterns=**/*mobile*", "--path-ignore-patterns=**/*mobile*/**"]
    : [`--path-ignore-patterns=${filter}`],
);

// Follow imports from all remaining test files, including tests in other workspaces.
await $`${process.execPath} run check:tmp --changed=${base} ${exclusions}`;
