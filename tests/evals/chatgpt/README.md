# ChatGPT conversation evaluations

`cases.json` is a prompt-and-expectation set for manual or future automated evaluations of the Local Workspace MCP App. It is **not** a record that these conversations have run. The current status is `NOT_RUN` until a real ChatGPT session has captured its tool calls and results.

## Run protocol

1. Use a dedicated disposable test workspace, not a personal or production directory. Record the `bridge_status` gates and per-workspace grants before each run.
2. Start a new ChatGPT conversation with the MCP App selected. Execute each prompt as written; preserve the exact tool sequence, arguments (with IDs redacted), result state, and user-visible answer.
3. For proposal cases, a human must inspect the diff and approve in the local console. Do not automate or infer that approval. Do not run `change_apply` before a local approval record exists.
4. Verify file bytes and hashes independently for any approved write. Clean up only the disposable fixture using a separate, explicit local action.
5. Redact credentials, one-time console URLs, absolute paths, and private content from evaluation records. A test result is not a security gate sign-off; G0–G6 require their own evidence and reviewer.

Each case separates expected tools from forbidden calls and answer assertions. `must_not_call` names MCP tools; instructions such as “no Shell, commit, or push” are response-level assertions because those actions are not exposed as Local Workspace tools.
