# LiteLLM

T3 Code can run Claude, Codex, OpenCode, and Pi through a [LiteLLM](https://docs.litellm.ai)
gateway with the LiteLLM CLI (`lite`). Each harness keeps working as usual, but it signs in
with your gateway's SSO and uses the gateway's models. This lets you, for example, use a
GPT model on the Claude harness.

## Set Up LiteLLM

1. On the machine that runs the T3 Code server, install the LiteLLM CLI 1.102.0 or newer
   and the harnesses you want to use:

   ```sh
   uv tool install 'litellm[cli]'
   ```

2. Set `LITELLM_PROXY_URL` to your gateway URL in your shell profile, for example
   `export LITELLM_PROXY_URL=https://litellm.example.com`. The desktop app reads it from your
   login shell. You can also set it in a provider instance's **Environment variables**.
3. In **Settings > Providers**, choose **Add provider**, pick Claude, Codex, OpenCode, or Pi,
   and turn on **Launch through LiteLLM**. The suggested label is, for example,
   **LiteLLM Claude**, and that is the name the model picker shows. To route an existing
   provider instead, such as the built-in Codex or Claude, open it and turn on
   **Launch through LiteLLM**.
4. Choose **Sign in**, then **Open browser**, and finish your gateway's SSO sign-in.

You keep one LiteLLM sign-in per user account on the server. All LiteLLM instances share it,
and signing in or out on one instance applies to all of them. `lite` renews the key on its own
for up to 14 days; after that, sign in again.

A running agent keeps the key and the model list it started with. Each new thread starts its
own agent. After a renewal or a change to the gateway's models, T3 Code restarts an idle agent
before its next message and resumes the conversation. If a key still expires during a turn,
and that turn had not run any commands or edits yet, T3 Code sends your message again once.

If `lite` can no longer renew the key (after 14 days, or if the gateway revoked it), the
provider shows as signed out and your message is not sent. Sign in again, then send it again.

If you sign in from another device and the final `localhost` page does not load, copy its
full URL and paste it in T3 Code when it asks.

## Models

- **LiteLLM Claude** lists every model the gateway offers.
- **LiteLLM Codex**, **LiteLLM OpenCode**, and **LiteLLM Pi** list the models that `lite`
  syncs into those harnesses.

T3 Code checks the gateway's model list at most once a minute, and **Refresh** in
**Settings > Providers** checks it now. If the gateway removes the model a thread uses, the
model picker marks it unavailable and the next message fails until you select another model.

The gateway translates between model families, so effort and thinking controls might not
apply to every model.

## Request Tags

T3 Code sends [request tags](https://docs.litellm.ai/docs/proxy/request_tags) with LiteLLM
Claude, Codex, and OpenCode agent turns, so you can track spend by tag on the gateway. Titles,
commit messages, and other text generation do not carry tags.

- By default, each request carries the repository name, for example `repo:t3code`,
  `project:general-admin`, and the harness, for example `tool:T3-Code/claude`. To use your own text
  instead of the repository name, or to turn all three off, change **LiteLLM default request tag**
  in **Settings > Providers > Advanced**.
- To set tags for one thread, use **Tags** in the composer. Fill in **Jira ticket**, **Project**,
  **Environment**, or **Tool**, and T3 Code adds the category for you, for example
  `jira:PROJ-1234`. Use **Other tags** for your own categories, such as `team:platform`. Separate
  more than one value with commas. A tag can have 64 characters, with its category. Any tag
  replaces `project:general-admin`, and **Tool** replaces the harness tag. A change applies from the next message after the thread's background work ends.
  A change to the default tag applies the same way.
- Threads that a thread starts, such as delegated tasks, forks, and threads an agent creates,
  copy its tags. A scheduled task keeps the tags you set on it.

LiteLLM Pi does not send request tags yet.

## Limits

- LiteLLM Codex and LiteLLM Pi use their own config directory, so they do not read your
  usual Codex or Pi config, skills, or extensions. A Codex provider you switch to LiteLLM
  might not resume threads it started before the switch.
- When the selected text generation model is not on the gateway, commit messages, titles,
  and branch names use the first gateway model.
- LiteLLM Codex does not accept `-c` or `--config` in **Launch arguments**, because Codex
  would then skip the gateway.
- LiteLLM OpenCode does not work with **Server URL**; T3 Code must start the OpenCode server.
- LiteLLM OpenCode does not send request tags if you set `OPENCODE_CONFIG`.
- A thread from before T3 Code 0.1.8 can share a LiteLLM Codex or OpenCode process with other
  threads. It keeps the tags that process started with until the process stops.
- The launcher is not available on Windows yet.
