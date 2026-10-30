import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerOwnerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  serverGeneration: string | undefined;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
  /** Servers from an older launch generation, closed when their last borrower returns. */
  readonly draining: Map<
    OpenCodeRuntime.OpenCodeServerProcess,
    { readonly scope: Scope.Closeable; borrowers: number }
  >;
}

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  {
    readonly withServer: <A, E, R>(
      use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeServerOwner") {}

export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
  /** A server keeps the key and models it started with; a new generation gets a new server. */
  readonly launchGeneration?: Effect.Effect<string | undefined>;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const state: OpenCodeServerOwnerState = {
    server: null,
    serverScope: null,
    serverGeneration: undefined,
    borrowers: 0,
    idleCloseFiber: null,
    draining: new Map(),
  };

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (
    expected?: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    if (expected !== undefined && state.server !== expected) {
      return;
    }
    const scope = state.serverScope;
    state.server = null;
    state.serverScope = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        const drained = state.draining.get(server);
        if (drained !== undefined) {
          state.draining.delete(server);
          yield* Scope.close(drained.scope, Exit.void).pipe(Effect.ignore);
          return;
        }
        if (state.server !== server) {
          return;
        }
        yield* cancelIdleClose();
        yield* closeServer(server);
      }),
    );
  });

  const acquireServer = mutex.withPermit(
    Effect.gen(function* () {
      yield* cancelIdleClose();
      const generation = input.launchGeneration ? yield* input.launchGeneration : undefined;
      if (state.server !== null) {
        const running = yield* state.server.isRunning;
        const stale = generation !== undefined && generation !== state.serverGeneration;
        if (running && !stale) {
          state.borrowers += 1;
          return state.server;
        }
        if (running && state.borrowers > 0 && state.serverScope !== null) {
          state.draining.set(state.server, {
            scope: state.serverScope,
            borrowers: state.borrowers,
          });
          state.server = null;
          state.serverScope = null;
        } else {
          yield* closeServer(state.server);
        }
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const serverScope = yield* Scope.make();
          const started = yield* Effect.exit(
            restore(
              runtime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  directory: input.directory,
                  ...(input.serverPassword !== undefined
                    ? { serverPassword: input.serverPassword }
                    : {}),
                  ...(input.environment ? { environment: input.environment } : {}),
                  ...(input.verify ? { verify: input.verify } : {}),
                })
                .pipe(Effect.provideService(Scope.Scope, serverScope)),
            ),
          );
          if (Exit.isFailure(started)) {
            yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }

          const server = started.value;
          state.server = server;
          state.serverScope = serverScope;
          state.serverGeneration = generation;
          state.borrowers = 1;
          yield* watchServerExit(server).pipe(Effect.forkIn(ownerScope));
          return server;
        }),
      );
    }),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const drained = state.draining.get(server);
        if (drained !== undefined) {
          drained.borrowers -= 1;
          if (drained.borrowers > 0) return;
          state.draining.delete(server);
          yield* Scope.close(drained.scope, Exit.void).pipe(Effect.ignore);
          return;
        }
        if (state.server !== server) {
          return;
        }
        state.borrowers = Math.max(0, state.borrowers - 1);
        if (state.borrowers > 0) {
          return;
        }
        yield* cancelIdleClose();
        state.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (state.server !== server || state.borrowers > 0) {
                  return;
                }
                state.idleCloseFiber = null;
                yield* closeServer(server);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        state.borrowers = 0;
        yield* closeServer();
        const draining = [...state.draining.values()];
        state.draining.clear();
        yield* Effect.forEach(draining, (drained) =>
          Scope.close(drained.scope, Exit.void).pipe(Effect.ignore),
        );
      }),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: Effect.fn("OpenCodeServerOwner.withServer")(function (use) {
      return Effect.uninterruptibleMask((restore) =>
        restore(acquireServer).pipe(
          Effect.flatMap((server) =>
            restore(use(server)).pipe(Effect.ensuring(releaseServer(server))),
          ),
        ),
      );
    }),
  });
});

/** @public */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntime.OpenCodeRuntimeError>;
  readonly launchGeneration?: Effect.Effect<string | undefined>;
}) => Layer.effect(OpenCodeServerOwner, make(input));
