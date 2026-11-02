import { create } from "@bufbuild/protobuf";
import { bots } from "@open-agents/contracts";
import { Effect } from "effect";
import { BotStore } from "../store.ts";
import { define, json, object, provider, providerSchema, str } from "./shared.ts";

export const botTools = [
  define("create_bot", "Bots: create another bot on an existing endpoint instance (CLI native login cannot run a gateway bot). Requires approval. No tools for editing or archiving other bots. Environment and credentials are never accepted.", object({
    name: str, provider: providerSchema, provider_instance: str, model: str, effort: str, instructions: str, shape: str, color: str,
    approval_policy: { type: "string", enum: ["safe", "always"] },
  }, ["name", "provider", "provider_instance", "model"]), "Creating a bot", (c) => {
    const configuration = create(bots.BotConfigurationSchema, {
      name: c.string("name", 80), provider: provider(c.args["provider"]), providerInstance: c.string("provider_instance"),
      model: c.string("model"), effort: c.optional("effort"), instructions: c.optional("instructions"),
      shape: c.optional("shape") || "round", color: c.optional("color") || "#22aaff", approvalPolicy: c.optional("approval_policy") || "safe",
    });
    return c.options.runtime.runPromise(BotStore.use((s) => s.action(c.turn, c.call,
      s.save(c.options.userId, configuration, { requestId: c.call.id }).pipe(Effect.map((bot) => json(bots.BotSchema, bot))),
    )));
  }, "approval"),
];
