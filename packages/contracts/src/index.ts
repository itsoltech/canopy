// Single entry point for the gateway <-> worker contract.
// Generated code lives in ./gen (do not edit, run `bun run gen`).
export * from "./gen/canopy/worker/v1/worker_link_pb.ts";

// UI API (gateway <-> browser). Namespaced to keep worker and UI names apart (Thread, Worker, ...).
export * as ui from "./ui.ts";
export * as bots from "./gen/canopy/ui/v1/bots_pb.ts";
export * as connectors from "./gen/canopy/ui/v1/connectors_pb.ts";
export * as update from "./gen/canopy/update/v1/update_pb.ts";
export * as computerLink from "./gen/canopy/link/v1/link_pb.ts";
