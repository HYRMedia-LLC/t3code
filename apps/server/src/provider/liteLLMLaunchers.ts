import type { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import type { LiteLLMLauncherSpec } from "@t3tools/provider-core/server/litellm";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import type { PiSettings } from "@t3tools/provider-pi/settings";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";

import { DEFAULT_CLAUDE_MODEL_CAPABILITIES } from "./ClaudeProvider.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

// Codex drops root-level `-c` overrides, which is where `lite codex` puts the
// gateway provider, once any `-c` follows a subcommand (BerriAI/litellm#40651).
// Launch args land after `app-server`, so they would silently bypass the gateway.
const CODEX_CONFIG_FLAG = /^(-c|--config)(=|$)/;

export const LITELLM_CODEX: LiteLLMLauncherSpec<CodexSettings> = {
  harness: "codex",
  configure: (config, launch) =>
    config.setupMode === "managed"
      ? Effect.fail("A T3-managed Codex cannot run through LiteLLM.")
      : tokenizeCliArgs(resolveCodexLaunchArgs(config.launchArgs, launch.environment)).some((arg) =>
            CODEX_CONFIG_FLAG.test(arg),
          )
        ? Effect.fail(
            "Remove -c/--config from Launch arguments and T3CODE_CODEX_LAUNCH_ARGS to run Codex through LiteLLM.",
          )
        : Effect.succeed({
            ...config,
            binaryPath: launch.binaryPath,
            homePath: config.homePath || launch.homeDir,
          }),
};

export const LITELLM_CLAUDE: LiteLLMLauncherSpec<ClaudeSettings> = {
  harness: "claude",
  configure: (config, launch) => Effect.succeed({ ...config, binaryPath: launch.binaryPath }),
  gatewayModelCapabilities: DEFAULT_CLAUDE_MODEL_CAPABILITIES,
};

export const LITELLM_OPENCODE: LiteLLMLauncherSpec<OpenCodeSettings> = {
  harness: "opencode",
  configure: (config, launch) =>
    config.serverUrl
      ? Effect.fail("Clear Server URL: LiteLLM can only route an OpenCode server T3 starts.")
      : Effect.succeed({ ...config, binaryPath: launch.binaryPath }),
};

export const LITELLM_PI: LiteLLMLauncherSpec<PiSettings> = {
  harness: "pi",
  configure: (config, launch) => Effect.succeed({ ...config, binaryPath: launch.binaryPath }),
  homeEnvironment: (homeDir) => ({ PI_CODING_AGENT_DIR: homeDir }),
};
