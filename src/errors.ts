import { Schema } from "effect";

// Domain error for the control plane. Effect v4 beta.70 exposes the tagged
// error class factory as Schema.TaggedErrorClass (effect.solutions documents
// it as Schema.TaggedError; the published beta name is TaggedErrorClass,
// verified in vendor/effect/packages/effect/src/Schema.ts). The produced
// class is a Cause.YieldableError: serializable, carries a _tag for pattern
// matching, and is yieldable directly inside Effect.gen.

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>(
  "@valkey2/ConfigError",
)("ConfigError", {
  field: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `invalid configuration for '${this.field}': ${this.reason}`;
  }
}