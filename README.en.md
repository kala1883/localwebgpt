# LocalWebGPT (Local Workspace Bridge)

LocalWebGPT is a Windows-local MCP bridge. ChatGPT on the web calls local tools through OpenAI Secure MCP Tunnel. The operator explicitly registers each local directory or file and chooses the tools allowed for that root in the local console. It does not scan or upload an entire disk automatically. File content returned by a tool is sent to ChatGPT, so read-only access still sends data off the machine.

中文说明：[README.md](README.md) · [Operator runbook](docs/operator-runbook.md) · [V1 acceptance record](docs/release/V1-acceptance.md) · [Windows install and upgrade](docs/install-and-upgrade.md) · [ChatGPT Tunnel acceptance](docs/chatgpt-tunnel-acceptance.md)

## How it works

```text
ChatGPT web MCP App (Tunnel)
              ⇅ OpenAI Secure MCP Tunnel
local tunnel-client → MCP adapter / daemon → console-authorized roots
```

The local `tunnel-client` initiates outbound HTTPS to OpenAI. You do not need an inbound public port, and you should not enter `localhost` as a public Server URL in ChatGPT. A Tunnel carries requests; it does not grant access to local paths. Public plugin distribution is a separate deployment model that requires a stable, publicly reachable HTTPS MCP endpoint.

## Prerequisites and permissions

- Windows x64, Node.js `>=22.12.0`, and npm. For a source checkout, install dependencies first with `npm ci`.
- A ChatGPT workspace where Developer mode is available.
- Platform Tunnel permissions and outbound HTTPS to OpenAI (normally `api.openai.com:443`).
- These permissions are separate: creating/editing a Tunnel requires Platform `Tunnels Read + Manage`; running `tunnel-client` or selecting the Tunnel in ChatGPT requires `Tunnels Read + Use`; ChatGPT Developer mode is controlled separately by workspace settings and admin policy.

## 1. Create a Tunnel and get its `tunnel_id`

1. Sign in to [OpenAI Platform Tunnel settings](https://platform.openai.com/settings/organization/tunnels) and select the correct Platform organization.
2. Use the page's create-Tunnel action, give the Tunnel a recognizable name, and create it.
3. Open the new Tunnel's details and copy its `tunnel_id` (for example, `tunnel_…`). This is an identifier, not a secret.
4. In the Tunnel's organization/workspace associations, include both the owning Platform organization and the ChatGPT workspace that will use it. A Tunnel associated only with a personal Platform organization may not appear in an Enterprise/Edu workspace.

If the create/manage controls are missing, ask the Platform organization owner or RBAC admin for the permissions above. If the target ChatGPT workspace is unavailable in the association UI, contact its admin; enterprise mappings that cannot be verified automatically may require the OpenAI account team.

## 2. Create a runtime API key

`tunnel-client` needs a **runtime API key** to authenticate to the Tunnel control plane. Create/issue a runtime key for `tunnel-client` through the Platform Tunnel settings flow, and ensure it has `Tunnels Read + Use`. Do not enter this key in the ChatGPT MCP App's OAuth section; this project uses **No authentication** for the ChatGPT App.

The current OpenAI Secure MCP Tunnel guide documents the runtime key's purpose and permissions, but does not promise identical click-by-click key-creation controls for every account. If you cannot find an explicit runtime-key create/copy flow in Tunnel settings, ask your organization admin rather than guessing or substituting an ordinary project API key. Store the key only in the local `.env`; never send it in chat, screenshots, logs, or Git.

## 3. Configure and start the local service

Create `.env` at the repository root (or the runtime root for a packaged build) with these entries, replacing the placeholders:

```dotenv
tunnel_id=tunnel_ID_copied_from_Platform
runtime_API_key=runtime_key_created_in_Platform
```

`.env` is Git-ignored and is not copied by the packaging script. On the first run of a fresh checkout, install dependencies from the repository root:

```powershell
Set-Location 'D:\MyProjects\MyApps\LocalWebGPT'
npm ci
```

Before each launch from a source checkout, validate `.env` and run the integrated launcher:

```powershell
Set-Location 'D:\MyProjects\MyApps\LocalWebGPT'
.\packaging\windows\Start-LocalWebGPT.ps1 -ValidateOnly
.\packaging\windows\Start-LocalWebGPT.ps1
```

Validation should report that `.env` is valid without displaying the key. The launcher starts the local daemon and prints a **one-time local-console URL**. Open that exact URL in a browser (do not share it; it contains a temporary authorization token), go to **ChatGPT Connection**, review the confirmation, and click **Enable ChatGPT connection on this machine**. This enables connection-level tool discovery only; it does not authorize a directory. After confirmation, the launcher runs Tunnel doctor and starts `tunnel-client`; wait for a healthy Tunnel before creating the ChatGPT App.

> Why this local step comes first: LocalWebGPT also guards MCP tool-list discovery behind its connection-enable check. ChatGPT requests tool discovery when you click Create, so creation can fail if the local connection has not been enabled. Keep the local launcher and Tunnel running while using the App.

If PowerShell cannot find Node/npm, install a supported Node.js version and open a new terminal. Correct `.env` issues using the validation error; the launcher never prints secret values.

To stop the service, open another PowerShell window and run `.\packaging\windows\Stop-LocalWebGPT.ps1` from the source checkout (`.\Stop-LocalWebGPT.ps1` from a packaged runtime), then wait for the launcher window to return to its prompt. This sends a fixed local stop request rather than killing an arbitrary PID; the daemon waits for in-flight operations before closing.

## 4. Create the MCP App in ChatGPT

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**. If workspace policy blocks it, ask the workspace admin.
2. Open **Plugins**, click **+ / Add**, and create a developer-mode App.
3. Enter a user-facing name and description, such as `Local Workspace Bridge` and `Access workspaces I explicitly authorize on this machine`.
4. Set **Connection** to **Tunnel** and select the Tunnel you created. If it is not listed, paste its `tunnel_id`. Verify its workspace association and the app creator's `Tunnels Read + Use` permission.
5. Set **Authentication** to **No authentication**. The local `tunnel-client` uses the runtime key; do not paste it into the ChatGPT form.
6. Accept the risk notice, click **Create**, and review the discovered tools and descriptions.
7. In a new conversation, add the MCP App from the tools menu (`+` / More / Tools), then test connection-level tools such as `bridge_status` and `workspace_list`. After tool metadata changes, use **Refresh** in Plugins management and start a new conversation.

## 5. Grant tools per local root

Open the local console using the one-time URL from the launcher and go to **Workspaces**:

1. Register a directory or file by pasting its full local path. Start with a narrow test directory. If you explicitly want whole-volume access, register a fixed NTFS volume root such as `C:\`; this supersedes narrower grants on that volume and exposes all accessible paths to the tools you grant.
2. Choose **Read-only** or **Read + modify**. The latter lets you grant “File modifications” for this root; once granted, ChatGPT can directly create/edit text files without a per-change local approval.
3. Open **Configure ChatGPT tools** for that root and select the allowed tools:

   | Console grant | MCP tools |
   | --- | --- |
   | List directories/file names | `file_list` |
   | Read file contents | `file_read` and related snapshot/error details |
   | Search text | `text_search` |
   | Read Git status and diffs | `git_status`, `git_diff` |
   | Create/delete/apply change sets | `file_create` / `file_delete` / `change_prepare` / `change_apply`, executed under the workspace File modifications grant; deletion snapshots locally and does not require a separate `file_read` |
   | Edit existing files | `file_edit`; the same workspace must grant both Read file contents and File modifications |
   | Run commands (high risk) | `command_exec`; a separate grant for `cmd`, PowerShell, or Bash |

Each grant applies only to that root. Saving with no tools selected revokes that root's ChatGPT tool access. Calls require an enabled connection and active workspace. Read, Git, file modification, and command execution are controlled by the per-workspace grants on this page; platform acceptance status is informational, not a hidden global feature switch. Granting “File modifications” authorizes direct creation/deletion of ordinary files and application of change sets without per-change approval. Editing existing files (including `file_edit` and edit items in `change_prepare`) also requires a Read grant to obtain the latest hash and `read_token`; `file_edit` is not exposed until both grants are active on the same workspace. Deletion reads and snapshots the baseline locally in the same call (16 MiB per-file limit).

`command_exec` is a separate high-risk grant for writable directory workspaces (not single-file roots). It runs as the Windows user running LocalWebGPT, has a 25-second time limit, bounded output, and secret/local-absolute-path screening. The registered directory is only the **initial working directory, not a sandbox**: commands may access other paths available to that user, use the network, and bypass the protected file writer, per-file conflict checks, and snapshot rollback. Timeout, revocation, or pause may leave partial side effects. It can also run commands such as `git commit` / `git push` and package installers; these are not separate MCP tools and have no extra command-specific semantics. Grant it only to trusted connections and validate first in a dedicated disposable directory. The protected-path, identity/version, audit, and protected-writer behavior above still applies to the ordinary file tools.

## 6. Suggested acceptance and troubleshooting

Confirm the Tunnel is healthy, then test `bridge_status` → `workspace_list` → `file_list` / `file_read` / `text_search` against a test root. In the local console, grant only the tools needed on a **dedicated temporary directory**, then test `file_create` / `file_edit` and independently read them back. Test deletion with one direct `file_delete` call and verify that the target is absent. For multi-file changes, use `change_prepare` followed by `change_apply`. To test `command_exec`, separately grant it and start with harmless `Write-Output` / `echo` commands; then verify working directory, output filtering, revocation, and pause termination. Do not use a personal directory for first-time file or command tests.

- Create fails with HTTP 424 or tool-list errors: check that ChatGPT Connection was enabled in the local console, the launcher is still running, and `tunnel-client` is healthy.
- Tunnel is missing from the picker: verify Platform organization/ChatGPT workspace association and `Tunnels Read + Use` for the app creator.
- App appears but reads/writes fail with `NOT_AUTHORIZED`: check that root's tool grants and workspace state. Tunnel connectivity is not file authorization.
- ChatGPT shows stale tools: refresh the connection in Plugins management and start a new conversation.

## Official references

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
