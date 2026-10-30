import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { supportsRequestTags } from "./requestTags";

const config = (
  driver: string,
  launcher: "litellm" | undefined,
): Pick<ServerConfig, "providers" | "settings"> =>
  ({
    providers: [{ instanceId: "inst", driver }],
    settings: { providerInstances: { inst: { driver, ...(launcher ? { launcher } : {}) } } },
  }) as never;

describe("supportsRequestTags", () => {
  const id = ProviderInstanceId.make("inst");
  it.each([
    ["claudeAgent", "litellm", true],
    ["codex", "litellm", true],
    ["opencode", "litellm", true],
    ["pi", "litellm", false],
    ["codex", undefined, false],
  ] as const)("%s with launcher %s -> %s", (driver, launcher, expected) => {
    expect(supportsRequestTags(config(driver, launcher), id)).toBe(expected);
  });

  it("is false without a config or instance", () => {
    expect(supportsRequestTags(null, id)).toBe(false);
    expect(supportsRequestTags(config("codex", "litellm"), null)).toBe(false);
  });
});
