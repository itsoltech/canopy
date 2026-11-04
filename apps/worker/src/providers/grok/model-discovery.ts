import { Schema } from "effect";

const ModelMetadata = Schema.Struct({
  reasoningEfforts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, default: Schema.optionalKey(Schema.Boolean) })),
  ),
});

export const ModelDiscovery = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Struct({
      modelState: Schema.optionalKey(
        Schema.Struct({
          currentModelId: Schema.String,
          availableModels: Schema.Array(
            Schema.Struct({
              modelId: Schema.String,
              name: Schema.String,
              description: Schema.optionalKey(Schema.String),
              _meta: Schema.optionalKey(ModelMetadata),
            }),
          ),
        }),
      ),
    }),
  ),
});

// ACP lists the highest effort first; composers expect lowest first.
export const effortRank = new Map([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
  ["ultra", 7],
]);
