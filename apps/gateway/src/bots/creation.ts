import { randomInt } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { Invalid } from "../store/store.ts";

// Same choices as the appearance wizard. No UI dependency in the gateway.
const shapes = ["round", "cloud", "diamond", "spark", "clover", "blob", "flower", "droplet", "pill", "triangle", "square", "star", "hexagon", "pumpkin"];
const colors = ["#27272a", "#926344", "#ef4444", "#f97316", "#fbbf24", "#65a30d", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#a1a1aa"];
const fields = ["name", "shape", "color", "instructions", "provider", "provider_instance", "model", "effort", "approval_policy"];

/** Resolved once, then durably stored with the approval; retries never reroll appearance or defaults. */
export function proposedBot(args: Record<string, unknown>, own: bots.BotConfiguration): bots.BotConfiguration {
  for (const [key, value] of Object.entries(args)) {
    if (!fields.includes(key)) throw new Invalid(`unknown field ${key}`);
    if (typeof value !== "string") throw new Invalid(`${key} must be a string`);
  }
  if (typeof args["name"] !== "string") throw new Invalid("name is required");
  if (args["provider"] !== undefined && !["codex", "claude"].includes(args["provider"] as string)) throw new Invalid("provider must be claude or codex");
  return create(bots.BotConfigurationSchema, {
    name: args["name"],
    shape: args["shape"] as string | undefined ?? shapes[randomInt(shapes.length)]!,
    color: args["color"] as string | undefined ?? colors[randomInt(colors.length)]!,
    provider: args["provider"] === undefined ? own.provider : args["provider"] === "claude" ? Provider.CLAUDE : Provider.CODEX,
    providerInstance: args["provider_instance"] as string | undefined ?? own.providerInstance,
    model: args["model"] as string | undefined ?? own.model,
    effort: args["effort"] as string | undefined ?? own.effort,
    instructions: args["instructions"] as string | undefined ?? "",
    approvalPolicy: args["approval_policy"] as string | undefined ?? own.approvalPolicy,
  });
}
