import type { ProviderInstanceId, ServerConfig } from "@t3tools/contracts";

const REQUEST_TAG_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex", "opencode"]);

/** Tags reach LiteLLM only through gateway instances of drivers that forward them. */
export function supportsRequestTags(
  config: Pick<ServerConfig, "providers" | "settings"> | null | undefined,
  instanceId: ProviderInstanceId | null | undefined,
): boolean {
  if (!config || !instanceId) return false;
  const driver = config.providers.find((provider) => provider.instanceId === instanceId)?.driver;
  return (
    driver !== undefined &&
    REQUEST_TAG_DRIVERS.has(driver) &&
    config.settings.providerInstances[instanceId]?.launcher === "litellm"
  );
}
