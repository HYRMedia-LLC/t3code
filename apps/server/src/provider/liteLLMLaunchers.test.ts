import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LITELLM_CODEX, LITELLM_OPENCODE } from "./liteLLMLaunchers.ts";

const decodeCodex = Schema.decodeSync(CodexSettings);
const decodeOpenCode = Schema.decodeSync(OpenCodeSettings);
const launch = {
  binaryPath: "/state/litellm/x/bin/codex",
  homeDir: "/state/litellm/x/home",
  environment: {},
};
const codex = (input: Partial<CodexSettings>) =>
  LITELLM_CODEX.configure(decodeCodex(input), launch).pipe(Effect.flip);
const defaults = decodeCodex({});
const chosenHome = decodeCodex({ homePath: "/work/codex" });
const externalOpenCode = decodeOpenCode({ serverUrl: "http://127.0.0.1:4096" });

it.effect("gives LiteLLM Codex its own home unless the user chose one", () =>
  Effect.gen(function* () {
    const own = yield* LITELLM_CODEX.configure(defaults, launch);
    assert.deepEqual([own.binaryPath, own.homePath], [launch.binaryPath, launch.homeDir]);
    const chosen = yield* LITELLM_CODEX.configure(chosenHome, launch);
    assert.equal(chosen.homePath, "/work/codex");
  }),
);

it.effect("refuses Codex launch args that would bypass the gateway", () =>
  Effect.gen(function* () {
    assert.match(yield* codex({ launchArgs: '-c model="o3"' }), /-c\/--config/);
    assert.match(yield* codex({ launchArgs: "--config=model=o3" }), /-c\/--config/);
    assert.match(yield* codex({ setupMode: "managed" }), /T3-managed/);
    const fromEnvironment = yield* LITELLM_CODEX.configure(defaults, {
      ...launch,
      environment: { T3CODE_CODEX_LAUNCH_ARGS: '-c model="o3"' },
    }).pipe(Effect.flip);
    assert.match(fromEnvironment, /T3CODE_CODEX_LAUNCH_ARGS/);
  }),
);

it.effect("refuses an external OpenCode server, which lite cannot route", () =>
  Effect.gen(function* () {
    const error = yield* LITELLM_OPENCODE.configure(externalOpenCode, launch).pipe(Effect.flip);
    assert.match(error, /Server URL/);
  }),
);

it("counts a Codex alias the harness resolves as a gateway model", () => {
  const listed = (slug: string, isCustom = false) => ({
    slug,
    name: slug,
    isCustom,
    capabilities: null,
  });
  assert.isTrue(LITELLM_CODEX.servesModel?.(listed("openai.gpt-5.6-luna"), "gpt-5.6-luna"));
  assert.isFalse(LITELLM_CODEX.servesModel?.(listed("openai.gpt-5.6-luna", true), "gpt-5.6-luna"));
  assert.isFalse(LITELLM_CODEX.servesModel?.(listed("gpt-5"), "gpt-5.6-luna"));
});
