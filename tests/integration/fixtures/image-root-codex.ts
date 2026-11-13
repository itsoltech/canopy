#!/usr/bin/env bun
/** Reuse the scripted dynamic-tool peer through the actual worker launch path. */
process.argv[2] = "show_images";

await import("../support/bus-app-server.ts");
