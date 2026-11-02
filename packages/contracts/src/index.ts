// Single entry point for the gateway <-> worker contract.
// Generated code lives in ./gen (do not edit, run `bun run gen`).
export * from "./gen/openagents/worker/v1/worker_link_pb.ts";

// UI API (gateway <-> browser). Namespaced to keep worker and UI names apart (Thread, Worker, ...).
export * as ui from "./ui.ts";
export * as bots from "./gen/openagents/ui/v1/bots_pb.ts";
