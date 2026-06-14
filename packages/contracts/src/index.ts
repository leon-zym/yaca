import { Type, type Static } from "typebox";
import * as Value from "typebox/value";

export { Value };

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    service: Type.Literal("yaca-host"),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    uptimeSeconds: Type.Number({ minimum: 0 }),
    authorityPort: Type.Integer({ minimum: 49_152, maximum: 50_175 }),
  },
  { additionalProperties: false },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
