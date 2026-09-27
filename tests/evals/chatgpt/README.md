# ChatGPT conversation evaluations

`cases.json` is a prompt-and-expectation set for manual or future automated evaluations of the Local Workspace MCP App. It is **not** a record that these conversations have run. The current status is `NOT_RUN` until a real ChatGPT session has captured its tool calls and results.

## Run protocol

1. Use a dedicated disposable test workspace, not a personal or production directory. Record the `bridge_status` facts and per-workspace grants before each run.
2. Start a new ChatGPT conversation with the MCP App selected. Execute each prompt as written; preserve the exact tool sequence, arguments (with IDs redacted), result state, and user-visible answer.
3. Directory grants are the user authorization for reads and writes. In a disposable workspace with the relevant grant, `file_create` and `file_edit` write directly in one tool call; multi-file changes use `change_prepare` followed by `change_apply`. Do not claim success unless the tool returns an applied state and receipt.
4. Verify file bytes and hashes independently after each write. Clean up only the disposable fixture with a separate, explicit local action; LocalWebGPT does not expose a delete tool.
5. Redact credentials, one-time console URLs, absolute paths, and private content from evaluation records. Keep real ChatGPT session status `NOT_RUN` until tool calls/results are captured from that session. Automated tests do not substitute for webpage acceptance or an independent security review.

Each case separates expected tools from forbidden calls and answer assertions. `must_not_call` names MCP tools; instructions such as “no Shell, commit, or push” are response-level assertions because those actions are not exposed as Local Workspace tools.
