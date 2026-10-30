import type { LiteLLMDefaultRequestTag } from "./settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

export const isProviderDriverKind = Schema.is(ProviderDriverKind);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

const ProviderInstanceEnvironmentVariableValue = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.Union([Schema.String, SecretReference]),
  sensitive: Schema.Boolean,
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});

// A reference is encoded beside an empty value so older servers and clients still decode it.
const StoredProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
  secret: Schema.optionalKey(SecretReference),
});

export const ProviderInstanceEnvironmentVariable = StoredProviderInstanceEnvironmentVariable.pipe(
  Schema.decodeTo(
    Schema.toType(ProviderInstanceEnvironmentVariableValue),
    SchemaTransformation.transform<
      typeof ProviderInstanceEnvironmentVariableValue.Type,
      typeof StoredProviderInstanceEnvironmentVariable.Type
    >({
      decode: ({ secret, ...variable }) =>
        secret === undefined ? variable : { ...variable, value: secret },
      encode: ({ value, ...variable }) =>
        typeof value === "string"
          ? { ...variable, value }
          : { ...variable, value: "", secret: value },
    }),
  ),
);
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

/**
 * How the driver's CLI is started. Absent means the CLI runs directly; `litellm`
 * runs it through `lite <harness>` so a LiteLLM gateway owns routing and keys.
 */
export const ProviderInstanceLauncher = Schema.Literal("litellm");
export type ProviderInstanceLauncher = typeof ProviderInstanceLauncher.Type;

export const REQUEST_TAG_MAX_CHARS = 64;
export const REQUEST_TAGS_MAX = 16;

/** One LiteLLM request tag. Tags travel comma-separated, so a tag holds no comma. */
export const LiteLLMRequestTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(REQUEST_TAG_MAX_CHARS),
  Schema.isPattern(/^[^,]+$/),
);
export const LiteLLMRequestTags = Schema.Array(LiteLLMRequestTag).check(
  Schema.isMaxLength(REQUEST_TAGS_MAX),
);
export type LiteLLMRequestTags = typeof LiteLLMRequestTags.Type;

/** Splits free text on commas, trims, and drops empty and repeated tags. */
export const parseLiteLLMRequestTags = (text: string): Array<string> =>
  [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim().slice(0, REQUEST_TAG_MAX_CHARS))
        .filter((tag) => tag.length > 0),
    ),
  ].slice(0, REQUEST_TAGS_MAX);

/** A `category:value` tag, such as `jira:PROJ-1234`, goes to the gateway unchanged. */
export const isCategorizedLiteLLMRequestTag = (tag: string): boolean => /^[\w-]+:./.test(tag);

export const LITELLM_TOOL_TAG_PREFIX = "tool:";

const LITELLM_HARNESS_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
  opencode: "opencode",
};

/** The `tool:` value sent for a thread with no tool tag of its own, if any. */
export const automaticLiteLLMToolValue = (
  driver: string | undefined,
  defaultTag: LiteLLMDefaultRequestTag,
): string | undefined => {
  if (defaultTag.mode === "off") return undefined;
  const customTool =
    defaultTag.mode === "custom"
      ? parseLiteLLMRequestTags(defaultTag.custom).find((tag) =>
          tag.startsWith(LITELLM_TOOL_TAG_PREFIX),
        )
      : undefined;
  if (customTool) return customTool.slice(LITELLM_TOOL_TAG_PREFIX.length);
  const harness = driver === undefined ? undefined : LITELLM_HARNESS_BY_DRIVER[driver];
  return harness && `T3-Code/${harness}`;
};

/** What drivers receive: every secret reference has been read into a plain value. */
export type ResolvedProviderInstanceEnvironment = ReadonlyArray<
  Omit<ProviderInstanceEnvironmentVariable, "value"> & { readonly value: string }
>;

/** Drivers decode their own config; unknown-driver envelopes round-trip verbatim across versions. */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  launcher: Schema.optionalKey(ProviderInstanceLauncher),
  config: Schema.optionalKey(Schema.Unknown),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/** Driver-kind ids keep stored selections routable without migration. */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
