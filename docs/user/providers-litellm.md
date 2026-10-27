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

A running agent keeps the key it started with. After a renewal, T3 Code restarts the agent
before its next message and resumes the conversation. If a key still expires during a turn,
and that turn had not run any commands or edits yet, T3 Code sends your message again once.

If you sign in from another device and the final `localhost` page does not load, copy its
full URL and paste it in T3 Code when it asks.

## Models

- **LiteLLM Claude** lists every model the gateway offers.
- **LiteLLM Codex**, **LiteLLM OpenCode**, and **LiteLLM Pi** list the models that `lite`
  syncs into those harnesses.

The gateway translates between model families, so effort and thinking controls might not
apply to every model.

## Limits

- LiteLLM Codex and LiteLLM Pi use their own config directory, so they do not read your
  usual Codex or Pi config, skills, or extensions. A Codex provider you switch to LiteLLM
  might not resume threads it started before the switch.
- When the selected text generation model is not on the gateway, commit messages, titles,
  and branch names use the first gateway model.
- LiteLLM Codex does not accept `-c` or `--config` in **Launch arguments**, because Codex
  would then skip the gateway.
- LiteLLM OpenCode does not work with **Server URL**; T3 Code must start the OpenCode server.
- The launcher is not available on Windows yet.
