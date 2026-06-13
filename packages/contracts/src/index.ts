import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

export { Value };

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    service: Type.Literal("yaca-host"),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    uptimeSeconds: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const BootstrapResponseSchema = Type.Object(
  {
    application: Type.Literal("yaca"),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    protocol: Type.Object(
      {
        major: Type.Literal(1),
        minor: Type.Integer({ minimum: 0, maximum: 65_535 }),
      },
      { additionalProperties: false },
    ),
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export type BootstrapResponse = Static<typeof BootstrapResponseSchema>;
