import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LITELLM_CODEX, LITELLM_OPENCODE } from "./liteLLMLaunchers.ts";

const decodeCodex = Schema.decodeSync(CodexSettings);
const decodeOpenCode = Schema.decodeSync(OpenCodeSettings);
const launch = { binaryPath: "/state/litellm/x/bin/codex", homeDir: "/state/litellm/x/home" };
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
  }),
);

it.effect("refuses an external OpenCode server, which lite cannot route", () =>
  Effect.gen(function* () {
    const error = yield* LITELLM_OPENCODE.configure(externalOpenCode, launch).pipe(Effect.flip);
    assert.match(error, /Server URL/);
  }),
);
