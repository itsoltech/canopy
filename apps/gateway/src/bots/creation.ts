import { randomInt } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { Predicate } from "effect";
import { Invalid } from "../store/store.ts";

// Same choices as the appearance wizard. No UI dependency in the gateway.
const shapes = [
  "round",
  "cloud",
  "diamond",
  "spark",
  "clover",
  "blob",
  "flower",
  "droplet",
  "pill",
  "triangle",
  "square",
  "star",
  "hexagon",
  "pumpkin",
];

const colors = [
  "#27272a",
  "#926344",
  "#ef4444",
  "#f97316",
  "#fbbf24",
  "#65a30d",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#a1a1aa",
];

const fields = [
  "name",
  "shape",
  "color",
  "instructions",
  "provider",
  "provider_instance",
  "model",
  "effort",
  "approval_policy",
];

/** Resolved once, then durably stored with the approval; retries never reroll appearance or defaults. */
export function proposedBot(args: JsonObject, own: bots.BotConfiguration): bots.BotConfiguration {
  const given = new Map<string, string>();

  for (const [key, value] of Object.entries(args)) {
    if (!fields.includes(key)) throw new Invalid(`unknown field ${key}`);

    if (!Predicate.isString(value)) throw new Invalid(`${key} must be a string`);
    given.set(key, value);
  }

  const name = given.get("name");
  const provider = given.get("provider");

  if (name === undefined) throw new Invalid("name is required");

  if (provider !== undefined && !["codex", "claude", "grok"].includes(provider))
    throw new Invalid("provider must be claude, codex or grok");

  return create(bots.BotConfigurationSchema, {
    name,
    shape: given.get("shape") ?? shapes[randomInt(shapes.length)]!,
    color: given.get("color") ?? colors[randomInt(colors.length)]!,
    provider:
      provider === undefined
        ? own.provider
        : provider === "claude"
          ? Provider.CLAUDE
          : provider === "grok"
            ? Provider.GROK
            : Provider.CODEX,
    providerInstance: given.get("provider_instance") ?? own.providerInstance,
    model: given.get("model") ?? own.model,
    effort: given.get("effort") ?? own.effort,
    instructions: given.get("instructions") ?? "",
    approvalPolicy: given.get("approval_policy") ?? own.approvalPolicy,
  });
}
