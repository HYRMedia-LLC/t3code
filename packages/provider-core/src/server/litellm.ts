/**
 * Runs an existing harness (Claude, Codex, Pi, OpenCode) through the LiteLLM CLI
 * (`lite <harness>`), which signs in with SSO, routes the harness at the gateway
 * and syncs the gateway's models into the harness. T3 keeps no LiteLLM secrets:
 * `lite` owns the key, its refresh, and the gateway URL (`LITELLM_PROXY_URL`).
 */
import {
  ProviderSetupError,
  type ModelCapabilities,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import type * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ProviderDriver, ProviderDriverCreateInput, ProviderInstance } from "./driver.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import { ProviderDriverError } from "./errors.ts";
import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";
import * as ProviderAuthFlow from "./providerAuthFlow.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderHost from "./ProviderHost.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import { spawnAndCollect } from "./snapshotProbe.ts";

export type LiteLLMHarness = "claude" | "codex" | "pi" | "opencode";

/** `lite pi` first shipped in 1.102.0; `--pkce` login in 1.99.0. */
const MINIMUM_LITELLM_CLI_VERSION = "1.102.0";
const INSTALL_HINT = "Install the LiteLLM CLI with `uv tool install 'litellm[cli]'`.";
const STATUS_TTL_MS = 60_000;
/** `lite login` gives up after 300 s (`pkce_login.py` LOGIN_TIMEOUT_SECONDS). */
const LOGIN_TIMEOUT_MS = 300_000;
/** `lite` renews a key only inside this window (CLI_TOKEN_FRESHNESS_BUFFER_SECONDS). */
const LITE_RENEWAL_WINDOW_MS = 6 * 60_000;

const TokenMetadata = Schema.fromJsonString(
  Schema.Struct({ expires_at: Schema.optional(Schema.Number) }),
);
const decodeTokenMetadata = Schema.decodeUnknownOption(TokenMetadata);
/** Reads only the non-secret expiry `lite` keeps beside the keychain entry. */
const parseLiteLLMKeyExpiry = (tokenJson: string): number | undefined =>
  Option.getOrUndefined(decodeTokenMetadata(tokenJson))?.expires_at;

export type LiteLLMAuthState =
  | { readonly status: "authenticated" }
  | { readonly status: "unauthenticated" | "unavailable"; readonly message: string };

export interface LiteLLMStatus {
  readonly auth: LiteLLMAuthState;
  /** Gateway model ids; absent while signed out or when the gateway could not list them. */
  readonly models?: ReadonlyArray<string> | undefined;
}

/** A LiteLLM failure T3 explains itself, shown to the user as is. */
export class LiteLLMGatewayError extends Schema.TaggedError<LiteLLMGatewayError>()(
  "LiteLLMGatewayError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * `--version` goes straight to the harness: it needs no gateway, and `lite` would
 * print its routing banner, verify the key over the network and fail when signed
 * out. OpenCode: T3 passes `OPENCODE_CONFIG_CONTENT={}` by default, and `lite
 * opencode` only injects its gateway provider when that variable is unset.
 */
export const liteLLMShimScript = (harness: LiteLLMHarness): string =>
  [
    "#!/bin/sh",
    "# Written by T3 Code for a LiteLLM provider instance. Rewritten on every start.",
    `if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then exec ${harness} --version; fi`,
    ...(harness === "opencode"
      ? ['if [ "${OPENCODE_CONFIG_CONTENT-}" = "{}" ]; then unset OPENCODE_CONFIG_CONTENT; fi']
      : []),
    `exec lite ${harness} "$@"`,
    "",
  ].join("\n");

const CLI_VERSION_PATTERN = /LiteLLM Proxy CLI Version:\s*v?(\d+\.\d+\.\d+)/;
const parseLiteLLMCliVersion = (output: string): string | undefined =>
  CLI_VERSION_PATTERN.exec(output)?.[1];

const LOGIN_URL_PATTERN = /Opening browser to:\s*(https?:\/\/\S+)/;
const parseLiteLLMLoginUrl = (output: string): string | undefined =>
  LOGIN_URL_PATTERN.exec(output)?.[1];

const GatewayModels = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty()) })),
);
const decodeGatewayModels = Schema.decodeUnknownOption(GatewayModels);
export const parseLiteLLMModelIds = (stdout: string): ReadonlyArray<string> | undefined =>
  Option.getOrUndefined(decodeGatewayModels(stdout.trim()))?.map((model) => model.id);

/**
 * `lite` explains a failed `auth print-token` on stderr, without the key. A
 * missing gateway URL shows up as a key "not for this server", because `lite`
 * then falls back to localhost:4000.
 */
export const liteLLMSignedOutMessage = (stderr: string, hasGatewayUrl: boolean): string => {
  const reason =
    stderr
      .split("\n")
      .map((line) => line.replace(/^Error:\s*/, "").trim())
      .findLast((line) => line.length > 0)
      ?.slice(0, 300) ?? "Not signed in.";
  return hasGatewayUrl
    ? `LiteLLM: ${reason}`
    : `LiteLLM: ${reason} Set LITELLM_PROXY_URL to your gateway URL.`;
};

/**
 * The redirect target is `lite`'s own loopback listener, so a callback pasted from
 * another device is only forwarded when it targets that listener.
 */
export const liteLLMCallbackTarget = (
  authorizationUrl: string,
  callbackUrl: string,
): string | undefined => {
  try {
    const redirect = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? "");
    const callback = new URL(callbackUrl.trim());
    const loopback = (host: string) => host === "127.0.0.1" || host === "localhost";
    if (
      redirect.protocol !== "http:" ||
      callback.protocol !== "http:" ||
      !loopback(redirect.hostname) ||
      !loopback(callback.hostname) ||
      redirect.port !== callback.port ||
      redirect.pathname !== callback.pathname
    )
      return undefined;
    return `${redirect.origin}${callback.pathname}${callback.search}`;
  } catch {
    return undefined;
  }
};

const modelListKey = (models: ReadonlyArray<string>) => [...models].sort().join("\n");

const mergeGatewayModels = (
  current: ReadonlyArray<ServerProviderModel>,
  gatewayIds: ReadonlyArray<string>,
  capabilities: ModelCapabilities | null,
): ReadonlyArray<ServerProviderModel> => {
  const known = new Map(current.map((model) => [model.slug, model]));
  const gateway = gatewayIds.map(
    (id) => known.get(id) ?? { slug: id, name: id, isCustom: false, capabilities },
  );
  const listed = new Set(gatewayIds);
  return [...gateway, ...current.filter((model) => model.isCustom && !listed.has(model.slug))];
};

/**
 * `gatewayModelCapabilities` is `undefined` for harnesses that list the models
 * `lite` syncs into them; otherwise the gateway's list replaces the catalog.
 */
export const applyLiteLLMStatus = (
  snapshot: ServerProvider,
  status: LiteLLMStatus,
  gatewayModelCapabilities: ModelCapabilities | null | undefined,
): ServerProvider => {
  const authenticated = status.auth.status === "authenticated";
  const ownsCatalog = gatewayModelCapabilities !== undefined;
  const base: ServerProvider = {
    ...snapshot,
    setup: { ...snapshot.setup, canAuthenticate: true, canInstall: false },
    auth: { status: authenticated ? "authenticated" : "unauthenticated", label: "LiteLLM SSO" },
    ...(ownsCatalog
      ? {
          models: mergeGatewayModels(
            snapshot.models,
            status.models ?? [],
            gatewayModelCapabilities,
          ),
        }
      : {}),
  };
  if (status.auth.status !== "authenticated" || !snapshot.enabled)
    return status.auth.status === "authenticated" || !snapshot.enabled
      ? base
      : { ...base, status: "error", message: status.auth.message };
  // The bundled catalog names models the gateway may not serve.
  if (ownsCatalog && status.models === undefined)
    return { ...base, status: "error", message: "LiteLLM: Could not list the gateway's models." };
  // The harness's own account check knows nothing about the gateway key.
  if (snapshot.auth.status !== "unauthenticated" || !snapshot.installed) return base;
  const { message: _message, ...rest } = base;
  return { ...rest, status: "ready" };
};

const runLite = Effect.fn("LiteLLM.runLite")(function* (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  return yield* spawnAndCollect("lite", ChildProcess.make("lite", [...args], { env: environment }));
});

const checkStatus = Effect.fn("LiteLLM.checkStatus")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<LiteLLMStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const hasGatewayUrl = Boolean(environment.LITELLM_PROXY_URL?.trim());
  const version = yield* runLite(["version"], environment).pipe(Effect.option);
  if (Option.isNone(version))
    return { auth: { status: "unavailable", message: `LiteLLM CLI not found. ${INSTALL_HINT}` } };
  const cliVersion = parseLiteLLMCliVersion(version.value.stdout);
  if (cliVersion && compareSemverVersions(cliVersion, MINIMUM_LITELLM_CLI_VERSION) < 0)
    return {
      auth: {
        status: "unavailable",
        message: `LiteLLM CLI ${cliVersion} is too old. Update it to ${MINIMUM_LITELLM_CLI_VERSION} or later.`,
      },
    };
  // Exit code only: stdout is the live key and is never kept or logged.
  const token = yield* runLite(["auth", "print-token"], environment).pipe(Effect.option);
  if (Option.isNone(token) || token.value.code !== 0)
    return {
      auth: {
        status: "unauthenticated",
        message: liteLLMSignedOutMessage(
          Option.isSome(token) ? token.value.stderr : "",
          hasGatewayUrl,
        ),
      },
    };
  const models = yield* runLite(["models", "list", "--format", "json"], environment).pipe(
    Effect.map((result) => (result.code === 0 ? parseLiteLLMModelIds(result.stdout) : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
  return { auth: { status: "authenticated" }, models };
});

export interface LiteLLMLauncherSpec<Config> {
  readonly harness: LiteLLMHarness;
  /** Points the driver at the shim and at an instance-owned home that `lite` may write to. */
  readonly configure: (
    config: Config,
    launch: {
      readonly binaryPath: string;
      readonly homeDir: string;
      /** The environment the harness process starts with. */
      readonly environment: NodeJS.ProcessEnv;
    },
  ) => Effect.Effect<Config, string>;
  /** Environment that places the harness home; user values win. */
  readonly homeEnvironment?: (homeDir: string) => Record<string, string>;
  /** Set when T3 owns the model catalog (Claude); other harnesses list what `lite` syncs. */
  readonly gatewayModelCapabilities?: ModelCapabilities | null;
  /** Aliases the harness resolves to a listed model; exact slugs always count. */
  readonly servesModel?: (model: ServerProviderModel, requested: string) => boolean;
}

export type LiteLLMLauncherEnv =
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Crypto.Crypto;

const makeLiteLLMAuth = Effect.fn("LiteLLM.makeAuth")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChange: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation, detail });
  return yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    // One `lite` login per OS user, shared by every LiteLLM instance.
    credentialBinding: { owner: "provider", key: "litellm" },
    methods: Effect.succeed([
      {
        id: "sso",
        name: "LiteLLM SSO",
        description: "Sign in through your gateway's SSO in the browser.",
        type: "agent",
      },
    ]),
    defaultMethodId: "sso",
    timeoutMs: LOGIN_TIMEOUT_MS,
    authenticate: Effect.fn("LiteLLM.authenticate")(function* (_methodId, context) {
      const exited = yield* Deferred.make<number>();
      // `BROWSER=true` stops `lite` opening a browser on the server host; the
      // client opens the link, so remote clients can sign in too.
      const child = yield* spawner
        .spawn(
          ChildProcess.make("lite", ["login", "--pkce"], {
            env: { ...input.environment, BROWSER: "true" },
          }),
        )
        .pipe(Effect.mapError(() => failure("start", `LiteLLM CLI not found. ${INSTALL_HINT}`)));
      yield* child.exitCode.pipe(
        Effect.flatMap((code) => Deferred.succeed(exited, Number(code))),
        Effect.catch(() => Deferred.succeed(exited, 1)),
        Effect.forkScoped,
      );
      const stderr = yield* Ref.make("");
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderr, (text) => (text + chunk).slice(-4_096))),
        Effect.ignore,
        Effect.forkScoped,
      );
      let stdout = "";
      let announced = false;
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => {
          stdout = (stdout + chunk).slice(-16_384);
          const url = announced ? undefined : parseLiteLLMLoginUrl(stdout);
          if (!url) return Effect.void;
          announced = true;
          return context.setInteraction(
            { type: "browser", id: "sso", url, requiresConsent: false, acceptsCallback: true },
            undefined,
            (callbackUrl) => {
              const target = liteLLMCallbackTarget(url, callbackUrl);
              return target === undefined
                ? Effect.fail(
                    failure("complete", "That is not the final localhost page of this sign-in."),
                  )
                : httpClient.get(target).pipe(
                    Effect.asVoid,
                    Effect.mapError(() =>
                      failure("complete", "The LiteLLM sign-in is no longer waiting. Start again."),
                    ),
                  );
            },
          );
        }),
        Effect.ignore,
        Effect.forkScoped,
      );
      if ((yield* Deferred.await(exited)) !== 0) {
        const message = liteLLMSignedOutMessage(
          yield* Ref.get(stderr),
          Boolean(input.environment.LITELLM_PROXY_URL?.trim()),
        );
        return yield* failure("start", message);
      }
      yield* context.verifying;
      const token = yield* runLite(["auth", "print-token"], input.environment).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.option,
      );
      if (Option.isNone(token) || token.value.code !== 0)
        return yield* failure("verify", "LiteLLM did not store a key. Start again.");
      yield* input.onChange;
    }),
    logout: runLite(["logout"], input.environment).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(() => failure("logout", `LiteLLM CLI not found. ${INSTALL_HINT}`)),
      Effect.tap(() => input.onChange),
      Effect.asVoid,
    ),
  });
});

const wrapSnapshot = (
  inner: ManagedServerProvider,
  status: Effect.Effect<LiteLLMStatus>,
  freshStatus: Effect.Effect<LiteLLMStatus>,
  apply: (snapshot: ServerProvider, status: LiteLLMStatus) => ServerProvider,
): ManagedServerProvider => ({
  ...inner,
  getSnapshot: Effect.zipWith(inner.getSnapshot, status, apply),
  refresh: Effect.zipWith(inner.refresh, freshStatus, apply),
  streamChanges: inner.streamChanges.pipe(
    Stream.mapEffect((snapshot) => status.pipe(Effect.map((current) => apply(snapshot, current)))),
  ),
});

const servesRequestedModel = (
  models: ReadonlyArray<ServerProviderModel>,
  requested: string,
  servesModel: LiteLLMLauncherSpec<unknown>["servesModel"],
) => models.some((model) => model.slug === requested || servesModel?.(model, requested) === true);

// Settings default to direct-provider model names that a gateway may not serve.
const withGatewayModels = (
  textGeneration: ProviderTextGeneration,
  snapshot: ManagedServerProvider,
  servesModel: LiteLLMLauncherSpec<unknown>["servesModel"],
): ProviderTextGeneration => {
  const onGatewayModel =
    <I extends { readonly modelSelection: ModelSelection }, A, E>(
      run: (input: I) => Effect.Effect<A, E>,
    ) =>
    (input: I) =>
      snapshot.getSnapshot.pipe(
        Effect.flatMap(({ models }) => {
          const listed = servesRequestedModel(models, input.modelSelection.model, servesModel);
          const fallback = models[0];
          return run(
            listed || fallback === undefined
              ? input
              : { ...input, modelSelection: { ...input.modelSelection, model: fallback.slug } },
          );
        }),
      );
  return {
    generateCommitMessage: onGatewayModel(textGeneration.generateCommitMessage),
    generatePrContent: onGatewayModel(textGeneration.generatePrContent),
    generateBranchName: onGatewayModel(textGeneration.generateBranchName),
    generateThreadTitle: onGatewayModel(textGeneration.generateThreadTitle),
    generateReviewGuide: onGatewayModel(textGeneration.generateReviewGuide),
  };
};

/**
 * Adds a `litellm` launcher to a driver. The variant writes a per-instance shim
 * that `exec`s `lite <harness>`, points the driver's `binaryPath` at it, and
 * overlays the gateway sign-in on the driver's snapshot.
 */
export const withLiteLLMLauncher = <Config, R, UsageR>(
  driver: ProviderDriver<Config, R, UsageR>,
  spec: LiteLLMLauncherSpec<Config>,
): ProviderDriver<Config, R | LiteLLMLauncherEnv, UsageR> => {
  const create = Effect.fn("LiteLLM.create")(function* (input: ProviderDriverCreateInput<Config>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const fail = (detail: string, cause?: unknown) =>
      new ProviderDriverError({
        driver: driver.driverKind,
        instanceId: input.instanceId,
        detail,
        cause,
      });
    if ((yield* HostProcess.Platform) === "win32")
      return yield* fail("The LiteLLM launcher is not supported on Windows yet.");

    const instanceDir = path.join(host.paths.stateDir, "litellm", input.instanceId);
    const binaryPath = path.join(instanceDir, "bin", spec.harness);
    const homeDir = path.join(instanceDir, "home");
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fileSystem.makeDirectory(homeDir, { recursive: true });
      yield* fileSystem.writeFileString(binaryPath, liteLLMShimScript(spec.harness));
      yield* fileSystem.chmod(binaryPath, 0o755);
    }).pipe(Effect.mapError((cause) => fail("Could not write the LiteLLM launcher.", cause)));

    const userEnvironment = new Set(input.environment.map((variable) => variable.name));
    const environment = [
      ...input.environment,
      ...Object.entries(spec.homeEnvironment?.(homeDir) ?? {})
        .filter(([name]) => !userEnvironment.has(name))
        .map(([name, value]) => ({ name, value, sensitive: false })),
    ];
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const config = yield* spec
      .configure(input.config, { binaryPath, homeDir, environment: processEnv })
      .pipe(Effect.mapError((detail) => fail(detail)));

    const scope = yield* Scope.Scope;
    const innerSnapshot = yield* Deferred.make<ManagedServerProvider>();
    const cached = yield* Ref.make<
      { readonly status: LiteLLMStatus; readonly checkedAt: number } | undefined
    >(undefined);
    const freshStatus = Effect.gen(function* () {
      const checkedAt = yield* Clock.currentTimeMillis;
      const next = yield* checkStatus(processEnv).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const previous = yield* Ref.getAndSet(cached, { status: next, checkedAt });
      // Harnesses list the models `lite` synced at spawn, so a new gateway list needs a new probe.
      if (
        previous?.status.models !== undefined &&
        next.models !== undefined &&
        modelListKey(previous.status.models) !== modelListKey(next.models)
      )
        yield* Deferred.await(innerSnapshot).pipe(
          Effect.flatMap((inner) => inner.refresh),
          Effect.forkIn(scope),
        );
      return next;
    });
    const status = Effect.gen(function* () {
      const current = yield* Ref.get(cached);
      if (current && (yield* Clock.currentTimeMillis) - current.checkedAt < STATUS_TTL_MS)
        return current.status;
      return yield* freshStatus;
    });
    const tokenPath = path.join(
      processEnv.HOME ?? (yield* HostProcess.HomeDirectory),
      ".litellm",
      "token.json",
    );
    const keyExpiry = fileSystem.readFileString(tokenPath).pipe(
      Effect.map(parseLiteLLMKeyExpiry),
      Effect.orElseSucceed(() => undefined),
    );
    // A process keeps the key and the model list `lite` gave it at spawn. Close to
    // expiry, renew first so the process started for the next turn gets the new key.
    const launchGeneration = Effect.gen(function* () {
      const expiry = yield* keyExpiry;
      if (expiry === undefined) return undefined;
      if (expiry * 1_000 - (yield* Clock.currentTimeMillis) <= LITE_RENEWAL_WINDOW_MS) {
        const renewed = yield* runLite(["auth", "print-token"], processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.map((result) => result.code === 0),
          Effect.orElseSucceed(() => false),
        );
        // Publish the sign-out now, so the thread shows the sign-in notice.
        if (!renewed) {
          yield* freshStatus.pipe(
            Effect.andThen(Deferred.await(innerSnapshot)),
            Effect.flatMap((inner) => inner.refresh),
            Effect.forkIn(scope),
          );
          return undefined;
        }
      }
      const renewedExpiry = yield* keyExpiry;
      const { models } = yield* status;
      return renewedExpiry === undefined || models === undefined
        ? undefined
        : `${renewedExpiry}:${modelListKey(models)}`;
    });

    const instance = yield* driver.create({ ...input, config, environment, launchGeneration });
    yield* Deferred.succeed(innerSnapshot, instance.snapshot);
    const snapshot = wrapSnapshot(instance.snapshot, status, freshStatus, (current, liteStatus) =>
      applyLiteLLMStatus(current, liteStatus, spec.gatewayModelCapabilities),
    );
    const auth = yield* makeLiteLLMAuth({
      instanceId: input.instanceId,
      environment: processEnv,
      onChange: snapshot.refresh.pipe(Effect.asVoid),
    });
    const adapter = instance.orchestrationAdapter;
    const perThreadSessions = (capabilities: OrchestrationV2ProviderCapabilities) => ({
      ...capabilities,
      sessions: { ...capabilities.sessions, supportsMultipleProviderThreadsPerSession: false },
    });
    return {
      ...instance,
      snapshot,
      auth,
      invalidateCaches: Ref.set(cached, undefined).pipe(
        Effect.andThen(instance.invalidateCaches ?? Effect.void),
      ),
      textGeneration: withGatewayModels(instance.textGeneration, snapshot, spec.servesModel),
      orchestrationAdapter: {
        ...adapter,
        launchGeneration,
        // New threads get their own session, so a new thread never inherits an old
        // key or model list. Threads already on a shared session keep sharing it.
        getCapabilities: () => adapter.getCapabilities().pipe(Effect.map(perThreadSessions)),
        openSession: Effect.fn("LiteLLM.openSession")(function* (session) {
          const current = yield* status;
          if (current.auth.status !== "authenticated")
            return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: adapter.driver,
              providerSessionId: session.providerSessionId,
              cause: new LiteLLMGatewayError({
                detail: `${current.auth.message} Sign in again in Settings > Providers.`,
              }),
            });
          const runtime = yield* adapter.openSession(session);
          return {
            ...runtime,
            startTurn: (turn) =>
              snapshot.getSnapshot.pipe(
                Effect.flatMap(({ models }) =>
                  models.length === 0 ||
                  servesRequestedModel(models, turn.modelSelection.model, spec.servesModel)
                    ? runtime.startTurn(turn)
                    : new ProviderAdapter.ProviderAdapterTurnStartError({
                        driver: adapter.driver,
                        threadId: turn.threadId,
                        providerThreadId: turn.providerThread.id,
                        runId: turn.runId,
                        cause: new LiteLLMGatewayError({
                          detail: `The LiteLLM gateway no longer serves ${turn.modelSelection.model}. Select another model.`,
                        }),
                      }),
                ),
              ),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
      },
    } satisfies ProviderInstance;
  });
  return { ...driver, launchers: { ...driver.launchers, litellm: { create } } };
};
