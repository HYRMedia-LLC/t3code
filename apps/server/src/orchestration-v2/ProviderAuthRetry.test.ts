import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isGatewayAuthRejection, retryAfterGatewayAuthRejection } from "./ProviderAuthRetry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:auth-retry");
const runId = RunId.make("run:auth-retry");
const instanceId = ProviderInstanceId.make("litellm_claude");
const providerSessionId = ProviderSessionId.make("session:auth-retry");
const userMessageId = MessageId.make("message:user");
const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");

const projection = (
  overrides: {
    readonly runs?: ReadonlyArray<Record<string, unknown>>;
    readonly turnItems?: ReadonlyArray<Record<string, unknown>>;
    readonly messages?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) =>
  ({
    thread: { id: threadId, providerInstanceId: instanceId },
    runs: overrides.runs ?? [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        userMessageId,
        status: "failed",
        requestedAt: now,
        completedAt: now,
      },
    ],
    messages: overrides.messages ?? [{ id: userMessageId, text: "Fix the build", attachments: [] }],
    turnItems: overrides.turnItems ?? [
      { runId, type: "user_message" },
      { runId, type: "assistant_message" },
      { runId, type: "error" },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

const run = (
  records: OrchestrationV2ThreadProjection,
  options: { readonly keepsStartupCredentials?: boolean } = {},
) =>
  Effect.gen(function* () {
    const commands: Array<
      Parameters<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>[0]
    > = [];
    const released: Array<ProviderSessionId> = [];
    yield* retryAfterGatewayAuthRejection({ threadId, sourceRunId: runId, providerSessionId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (_threadId, _kinds, filter) =>
              Effect.succeed({
                ...records,
                messages: records.messages.filter((message) =>
                  filter?.messageIds?.includes(message.id),
                ),
              }),
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            keepsStartupCredentials: () => Effect.succeed(options.keepsStartupCredentials ?? true),
            release: (input) => {
              released.push(input.providerSessionId);
              return Effect.void;
            },
          }),
        ),
      ),
    );
    return { commands, released };
  });

it("recognises a gateway key rejection from Claude's code or another harness's text", () => {
  const failure = (code: string | null, message: string) =>
    ({ class: "provider_error", code, message, retryable: false }) as const;
  assert.isTrue(isGatewayAuthRejection(failure("api_error_401", "Claude could not authenticate.")));
  assert.isTrue(
    isGatewayAuthRejection(
      failure(null, "unexpected status 401 Unauthorized: Authentication Error, key expired"),
    ),
  );
  assert.isFalse(isGatewayAuthRejection(failure("api_error_529", "Overloaded")));
});

it.effect("replaces the session and sends the user's message again once", () =>
  Effect.gen(function* () {
    const { commands, released } = yield* run(projection());
    assert.deepEqual(released, [providerSessionId]);
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    if (command.type !== "message.dispatch") return assert.fail("expected a message dispatch");
    assert.equal(command.text, "Fix the build");
    assert.equal(command.messageId, MessageId.make(`message:auth-retry:${runId}`));
    assert.deepEqual(command.modelSelection, { instanceId, model: "gpt-5" });
  }),
);

it.effect("leaves the failure alone when retrying could repeat or loop", () =>
  Effect.gen(function* () {
    const ranATool = projection({
      turnItems: [
        { runId, type: "command_execution" },
        { runId, type: "error" },
      ],
    });
    const alreadyRetried = projection({
      messages: [
        { id: userMessageId, text: "Fix the build", attachments: [] },
        { id: MessageId.make(`message:auth-retry:${runId}`), text: "", attachments: [] },
      ],
    });
    const retryOfRetry = projection({
      runs: [
        {
          ...projection().runs[0],
          userMessageId: MessageId.make("message:auth-retry:run:earlier"),
        },
      ],
    });
    for (const records of [ranATool, alreadyRetried, retryOfRetry]) {
      const { commands, released } = yield* run(records);
      assert.deepEqual([commands.length, released.length], [0, 0]);
    }
    const native = yield* run(projection(), { keepsStartupCredentials: false });
    assert.deepEqual([native.commands.length, native.released.length], [0, 0]);
  }),
);
