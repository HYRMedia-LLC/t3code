// @effect-diagnostics nodeBuiltinImport:off - fixtures write executable scripts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";

import type { ProviderDriver, ProviderDriverCreateInput, ProviderInstance } from "./driver.ts";
import { knownProviderFailureMessage } from "./failure.ts";
import {
  applyLiteLLMStatus,
  liteLLMCallbackTarget,
  liteLLMShimScript,
  liteLLMSignedOutMessage,
  parseLiteLLMModelIds,
  withLiteLLMLauncher,
} from "./litellm.ts";
import type {
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderHost from "./ProviderHost.ts";
import { spawnAndCollect } from "./snapshotProbe.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const capabilities = createModelCapabilities({ optionDescriptors: [] });
const instanceId = ProviderInstanceId.make("litellm_claude");

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", isCustom: false, capabilities },
    { slug: "my-alias", name: "My alias", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("applyLiteLLMStatus", () => {
  it("lists gateway models, keeping known entries and user custom models", () => {
    const result = applyLiteLLMStatus(
      snapshot(),
      { auth: { status: "authenticated" }, models: ["gpt-5", "claude-sonnet-4-5"] },
      capabilities,
    );
    assert.deepEqual(
      result.models.map((model) => [model.slug, model.name, model.isCustom]),
      [
        ["gpt-5", "gpt-5", false],
        ["claude-sonnet-4-5", "Claude Sonnet 4.5", false],
        ["my-alias", "My alias", true],
      ],
    );
    assert.strictEqual(result.models[0]?.capabilities, capabilities);
  });

  it("reports the gateway sign-in instead of the harness's own account", () => {
    const signedOut = applyLiteLLMStatus(
      snapshot(),
      { auth: { status: "unauthenticated", message: "LiteLLM: Not authenticated." } },
      null,
    );
    assert.deepEqual(
      [signedOut.status, signedOut.auth.status, signedOut.message],
      ["error", "unauthenticated", "LiteLLM: Not authenticated."],
    );
    assert.equal(signedOut.setup?.canAuthenticate, true);

    const harnessWantsLogin = applyLiteLLMStatus(
      snapshot({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Log in to Codex",
      }),
      { auth: { status: "authenticated" } },
      undefined,
    );
    assert.deepEqual(
      [harnessWantsLogin.status, harnessWantsLogin.auth.status, harnessWantsLogin.message],
      ["ready", "authenticated", undefined],
    );
  });

  it("reports a failed gateway model list instead of the bundled catalog", () => {
    const result = applyLiteLLMStatus(
      snapshot(),
      { auth: { status: "authenticated" } },
      capabilities,
    );
    assert.equal(result.status, "error");
    assert.deepEqual(
      result.models.map((model) => model.slug),
      ["my-alias"],
    );
  });

  it("keeps a disabled instance quiet", () => {
    const disabled = applyLiteLLMStatus(
      snapshot({ enabled: false, status: "disabled" }),
      { auth: { status: "unauthenticated", message: "LiteLLM: Not authenticated." } },
      null,
    );
    assert.equal(disabled.status, "disabled");
  });
});

describe("lite output parsing", () => {
  it("reads model ids from `lite models list --format json`", () => {
    assert.deepEqual(parseLiteLLMModelIds('[\n  {"id": "gpt-5", "object": "model"}\n]\n'), [
      "gpt-5",
    ]);
    assert.isUndefined(parseLiteLLMModelIds("Traceback (most recent call last):"));
  });

  it("explains a missing gateway URL", () => {
    assert.equal(
      liteLLMSignedOutMessage("Error: Not authenticated for this server.\n", false),
      "LiteLLM: Not authenticated for this server. Set LITELLM_PROXY_URL to your gateway URL.",
    );
  });

  it("only forwards callbacks for this sign-in's loopback listener", () => {
    const authorize =
      "https://gw.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback";
    assert.equal(
      liteLLMCallbackTarget(authorize, "http://localhost:5123/callback?code=c&state=s"),
      "http://127.0.0.1:5123/callback?code=c&state=s",
    );
    assert.isUndefined(liteLLMCallbackTarget(authorize, "http://127.0.0.1:9999/callback?code=c"));
    assert.isUndefined(liteLLMCallbackTarget(authorize, "https://evil.example/callback?code=c"));
  });
});

const FAKE_LITE = `#!/bin/sh
echo "$*" >> "$FAKE_LITE_DIR/calls"
case "$1" in
  version) echo "LiteLLM Proxy CLI Version: \${FAKE_LITE_VERSION:-1.106.2}" ;;
  auth)
    if [ -n "\${FAKE_LITE_RENEWED_EXPIRY-}" ]; then
      mkdir -p "$HOME/.litellm"; echo '{"expires_at": '"$FAKE_LITE_RENEWED_EXPIRY"'}' > "$HOME/.litellm/token.json"
    fi
    if [ -f "$FAKE_LITE_DIR/signed-in" ]; then echo sk-live-key; exit 0; fi
    echo "Error: Not authenticated. Run 'lite login'." >&2; exit 1 ;;
  models) cat "$FAKE_LITE_DIR/models" 2>/dev/null || echo '[{"id": "gpt-5"}]' ;;
  login)
    echo "Opening browser to: https://gw.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback"
    touch "$FAKE_LITE_DIR/signed-in" ;;
  logout) rm -f "$FAKE_LITE_DIR/signed-in" ;;
  *) echo "litellm: routing through proxy"; echo "lite-ran $* OPENCODE_CONFIG_CONTENT=\${OPENCODE_CONFIG_CONTENT-unset}" ;;
esac
`;

const makeFixture = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-litellm-"));
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin);
  for (const [name, body] of [
    ["lite", FAKE_LITE],
    ["claude", '#!/bin/sh\necho "2.1.0 (Claude Code)"\n'],
  ] as const) {
    NodeFS.writeFileSync(NodePath.join(bin, name), body, { mode: 0o755 });
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    FAKE_LITE_DIR: dir,
    HOME: dir,
    LITELLM_PROXY_URL: "https://gw.example",
  };
  return {
    dir,
    environment,
    calls: () => {
      const log = NodePath.join(dir, "calls");
      return NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
    },
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

interface FakeConfig {
  readonly binaryPath: string;
  readonly homePath: string;
}

const titleModels: Array<string> = [];
const startedTurns: Array<string> = [];

const sharedCapabilities = {
  sessions: { supportsMultipleProviderThreadsPerSession: true },
} as unknown as OrchestrationV2ProviderCapabilities;

const fakeAdapter = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(sharedCapabilities),
  openSession: (input: ProviderAdapterV2OpenSessionInput) =>
    Effect.succeed({
      providerSessionId: input.providerSessionId,
      providerSession: { capabilities: sharedCapabilities },
      startTurn: (turn: ProviderAdapterV2TurnInput) =>
        Effect.sync(() => void startedTurns.push(turn.modelSelection.model)),
    } as unknown as ProviderAdapterV2SessionRuntime),
} as unknown as ProviderInstance["orchestrationAdapter"];

const signIn = (fixture: ReturnType<typeof makeFixture>) =>
  NodeFS.writeFileSync(NodePath.join(fixture.dir, "signed-in"), "");
const setGatewayModels = (fixture: ReturnType<typeof makeFixture>, ids: ReadonlyArray<string>) =>
  NodeFS.writeFileSync(
    NodePath.join(fixture.dir, "models"),
    JSON.stringify(ids.map((id) => ({ id }))),
  );
const writeKeyExpiry = (fixture: ReturnType<typeof makeFixture>, expiresAt: number) => {
  const tokenPath = NodePath.join(fixture.dir, ".litellm", "token.json");
  NodeFS.mkdirSync(NodePath.dirname(tokenPath), { recursive: true });
  NodeFS.writeFileSync(tokenPath, JSON.stringify({ expires_at: expiresAt, base_url: "x" }));
};
const farExpiry = Math.floor(Date.UTC(2099, 0, 1) / 1_000);

const makeInnerDriver = (created: Array<ProviderDriverCreateInput<FakeConfig>>) =>
  ({
    driverKind: ProviderDriverKind.make("claudeAgent"),
    metadata: { displayName: "Fake" },
    configSchema: Schema.Struct({ binaryPath: Schema.String, homePath: Schema.String }),
    defaultConfig: () => ({ binaryPath: "claude", homePath: "" }),
    create: (input) =>
      Effect.sync(() => {
        created.push(input);
        const current = Effect.succeed(snapshot({ auth: { status: "unknown" } }));
        return {
          instanceId: input.instanceId,
          driverKind: ProviderDriverKind.make("claudeAgent"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationKey: "fake",
          },
          displayName: input.displayName,
          enabled: input.enabled,
          snapshot: {
            resolveMaintenance: () => Effect.die("unused"),
            getSnapshot: current,
            refresh: current,
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: fakeAdapter,
          textGeneration: {
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateBranchName: () => Effect.die("unused"),
            generateReviewGuide: () => Effect.die("unused"),
            generateThreadTitle: (request) =>
              Effect.sync(() => {
                titleModels.push(request.modelSelection.model);
                return { title: "Title" };
              }),
          },
        } satisfies ProviderInstance;
      }),
  }) satisfies ProviderDriver<FakeConfig>;

const createLiteLLMInstance = (
  fixture: ReturnType<typeof makeFixture>,
  created: Array<ProviderDriverCreateInput<FakeConfig>>,
) => {
  const driver = withLiteLLMLauncher(makeInnerDriver(created), {
    harness: "claude",
    configure: (config, launch) =>
      Effect.succeed({ ...config, binaryPath: launch.binaryPath, homePath: launch.homeDir }),
    homeEnvironment: (homeDir) => ({ FAKE_HOME: homeDir }),
    gatewayModelCapabilities: capabilities,
    servesModel: (model, requested) => model.slug === `my-${requested}`,
  });
  return driver
    .launchers!.litellm!.create({
      instanceId,
      displayName: "LiteLLM Claude",
      environment: Object.entries(fixture.environment)
        .filter(
          ([name]) =>
            name === "PATH" ||
            name === "HOME" ||
            name.startsWith("FAKE_") ||
            name.startsWith("LITELLM"),
        )
        .map(([name, value]) => ({ name, value: value ?? "", sensitive: false })),
      enabled: true,
      config: { binaryPath: "claude", homePath: "" },
    })
    .pipe(
      Effect.provideService(
        ProviderHost.ProviderHost,
        ProviderHost.ProviderHost.of({
          paths: {
            cwd: fixture.dir,
            baseDir: fixture.dir,
            stateDir: NodePath.join(fixture.dir, "state"),
            providerStatusCacheDir: NodePath.join(fixture.dir, "cache"),
            attachmentsDir: NodePath.join(fixture.dir, "attachments"),
          },
          settings: {
            get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
            changes: Stream.empty,
            subscribe: Effect.succeed(Stream.empty),
          },
          shouldRunBackgroundWork: () => Effect.succeed(true),
          resolveAttachmentPath: () => null,
          credentials: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("no callback is forwarded in these tests")),
      ),
    );
};

describe.skipIf(windowsHost)("withLiteLLMLauncher", () => {
  it.live("launches the harness through a per-instance lite shim", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const created: Array<ProviderDriverCreateInput<FakeConfig>> = [];
      yield* createLiteLLMInstance(fixture, created);
      const input = created[0]!;
      const shim = input.config.binaryPath;
      assert.equal(
        shim,
        NodePath.join(fixture.dir, "state", "litellm", instanceId, "bin", "claude"),
      );
      assert.deepEqual(
        input.environment.find((variable) => variable.name === "FAKE_HOME")?.value,
        input.config.homePath,
      );

      const run = (args: ReadonlyArray<string>) =>
        spawnAndCollect(shim, ChildProcess.make(shim, [...args], { env: fixture.environment }));
      assert.equal((yield* run(["--version"])).stdout.trim(), "2.1.0 (Claude Code)");
      assert.include((yield* run(["--print", "hi"])).stdout, "lite-ran claude --print hi");
      assert.notInclude(fixture.calls().join("\n"), "--version");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("signs in with lite login, then reports the gateway account and models", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const instance = yield* createLiteLLMInstance(fixture, []);

      const signedOut = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([signedOut.auth.status, signedOut.status], ["unauthenticated", "error"]);
      assert.notInclude(JSON.stringify(signedOut), "sk-live-key");

      const owner = "owner";
      const auth = instance.auth!;
      yield* auth.start(owner);
      const finished = yield* auth.subscribe(owner).pipe(
        Stream.filter((state: ProviderAuthState) => state.phase === "succeeded"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.equal(finished.phase, "succeeded");

      const signedIn = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([signedIn.auth.status, signedIn.status], ["authenticated", "ready"]);
      assert.deepEqual(
        signedIn.models.map((model) => model.slug),
        ["gpt-5", "my-alias"],
      );
      assert.include(fixture.calls(), "login --pkce");

      titleModels.length = 0;
      for (const model of ["gpt-6-luna", "my-alias", "alias"]) {
        yield* instance.textGeneration.generateThreadTitle({
          cwd: fixture.dir,
          message: "hi",
          modelSelection: { instanceId, model },
        });
      }
      assert.deepEqual(titleModels, ["gpt-5", "my-alias", "alias"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lets lite opencode inject its gateway unless the user set an OpenCode config", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const shim = NodePath.join(fixture.dir, "opencode-shim");
      NodeFS.writeFileSync(shim, liteLLMShimScript("opencode"), { mode: 0o755 });
      const run = (configContent: string) =>
        spawnAndCollect(
          shim,
          ChildProcess.make(shim, ["serve"], {
            env: { ...fixture.environment, OPENCODE_CONFIG_CONTENT: configContent },
          }),
        );
      assert.include((yield* run("{}")).stdout, "OPENCODE_CONFIG_CONTENT=unset");
      assert.include((yield* run('{"model":"x"}')).stdout, 'OPENCODE_CONFIG_CONTENT={"model":"x"}');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("renews the key before a session starts inside lite's renewal window", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      writeKeyExpiry(fixture, farExpiry);
      const generation = (yield* createLiteLLMInstance(fixture, [])).orchestrationAdapter
        .launchGeneration!;
      assert.equal(yield* generation, `${farExpiry}:gpt-5`);
      assert.notInclude(fixture.calls(), "auth print-token renew");

      writeKeyExpiry(fixture, 1);
      fixture.environment.FAKE_LITE_RENEWED_EXPIRY = String(farExpiry + 86_400);
      const renewing = (yield* createLiteLLMInstance(fixture, [])).orchestrationAdapter
        .launchGeneration!;
      assert.equal(yield* renewing, `${farExpiry + 86_400}:gpt-5`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts a new generation when the gateway's model list changes", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      signIn(fixture);
      writeKeyExpiry(fixture, farExpiry);
      const instance = yield* createLiteLLMInstance(fixture, []);
      const before = yield* instance.orchestrationAdapter.launchGeneration!;

      setGatewayModels(fixture, ["gpt-5", "gpt-6"]);
      const refreshed = yield* instance.snapshot.refresh;
      assert.deepEqual(
        refreshed.models.map((model) => model.slug),
        ["gpt-5", "gpt-6", "my-alias"],
      );
      const after = yield* instance.orchestrationAdapter.launchGeneration!;
      assert.notEqual(after, before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failed renewal as a sign-out instead of keeping the old generation", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      writeKeyExpiry(fixture, 1);
      const instance = yield* createLiteLLMInstance(fixture, []);
      assert.isUndefined(yield* instance.orchestrationAdapter.launchGeneration!);
      const current = yield* instance.snapshot.getSnapshot;
      assert.deepEqual([current.auth.status, current.status], ["unauthenticated", "error"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("opens one session per thread and refuses what the gateway cannot serve", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      const instance = yield* createLiteLLMInstance(fixture, []);
      const adapter = instance.orchestrationAdapter;
      const sessionInput = {
        providerSessionId: ProviderSessionId.make("session:litellm"),
      } as ProviderAdapterV2OpenSessionInput;
      const signedOut = yield* adapter.openSession(sessionInput).pipe(Effect.scoped, Effect.flip);
      assert.include(knownProviderFailureMessage(signedOut) ?? "", "Sign in again");

      signIn(fixture);
      yield* instance.snapshot.refresh;
      const capabilities = yield* adapter.getCapabilities();
      assert.isFalse(capabilities.sessions.supportsMultipleProviderThreadsPerSession);
      const runtime = yield* adapter.openSession(sessionInput).pipe(Effect.scoped);

      const turn = (model: string) =>
        ({
          threadId: "thread:1",
          runId: "run:1",
          modelSelection: { instanceId, model },
          providerThread: { id: "provider-thread:1" },
        }) as unknown as ProviderAdapterV2TurnInput;
      startedTurns.length = 0;
      yield* runtime.startTurn(turn("gpt-5"));
      const removed = yield* runtime.startTurn(turn("claude-sonnet-4-5")).pipe(Effect.flip);
      assert.include(
        knownProviderFailureMessage(removed) ?? "",
        "no longer serves claude-sonnet-4-5",
      );
      assert.deepEqual(startedTurns, ["gpt-5"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a lite CLI older than the minimum", () =>
    Effect.gen(function* () {
      using fixture = makeFixture();
      fixture.environment.FAKE_LITE_VERSION = "1.90.0";
      const instance = yield* createLiteLLMInstance(fixture, []);
      const current = yield* instance.snapshot.getSnapshot;
      assert.include(current.message, "LiteLLM CLI 1.90.0 is too old");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
