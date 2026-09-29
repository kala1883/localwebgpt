# Windows 安装与升级

## 当前状态

仓库提供一个 Windows x64 runtime 目录构建器：

```powershell
.\deployment\windows\build-runtime.ps1 -OutputDirectory "$env:LOCALAPPDATA\Programs\LocalWebGPT"
```

这条构建命令从源码仓库运行；生成的 runtime 目录不包含 `deployment/` 构建脚本。

输出目录必须不存在且位于仓库之外。脚本会把源码与锁定依赖复制到该目录，在**该目录**运行 `npm ci --ignore-scripts`，再核对 `better-sqlite3` 的 Windows x64 预编译二进制与已验证的 checkout 二进制逐字节相同，并从输出目录实际打开内存数据库验证它。这样无需在目标机安装 Visual Studio C++ workload；Console 构建和 FsGuard 导入边界也会在输出目录检查。隧道客户端只从匹配官方 `SHA256SUMS.txt` 的 v0.0.15 Windows amd64 压缩包提取，随包包含许可证文件。它不会复制 `.git`、整份当前 `node_modules`、本机 tunnel profile 或凭据，也不会改写用户的源仓库。构建要求源仓库已有相同 Node 版本的 `better-sqlite3` 安装；其他依赖跳过 install lifecycle 后由 Console 构建和原生 smoke test 验证。

此交付物是固定路径运行目录，不是签名安装器或可随意移动的 ZIP。npm workspace 链接指向所选绝对路径；移动目录会使链接失效。构建失败时脚本保留输出目录供检查，不会自动删除或覆盖它。

## 首次启动

在 PowerShell 中进入运行目录并运行一体化启动脚本：

```powershell
.\Start-LocalWebGPT.ps1
```

启动脚本从运行根目录（源码 checkout 根或已构建 runtime 根）的 `.env` 读取 `tunnel_id` / `runtime_API_key`，也接受规范名 `CONTROL_PLANE_TUNNEL_ID` / `CONTROL_PLANE_API_KEY`。格式为普通 `KEY=value`，空行和 `#` 注释会忽略；缺字段、重复字段和非法 tunnel ID 会在启动前拒绝，且错误信息不会回显值。示例：

```dotenv
tunnel_id=tunnel_从 Platform 复制的 ID
runtime_API_key=从 Platform 创建的 runtime key
# 可选：默认 1 GiB；可调至 2 GiB 以内，daemon 会拒绝超过硬上限的值
snapshot_store_max_bytes=536870912
```

`snapshot_store_max_bytes` 是可选的本机快照对象硬上限（十进制字节），缺省为 1 GiB，最大不可超过 2 GiB；超过上限时提案以 `STORAGE_UNAVAILABLE` 拒绝，工作区不写入。上限低于当前已有对象占用时不会删除旧快照，新的不同快照会被拒绝；相同内容去重仍可复用。daemon 启动时及运行中每小时执行保留感知回收；若活跃/待恢复操作阻止回收，则容量要等后续周期或重启后才能释放。

`.env` 被 Git 忽略。构建脚本不会复制源码 `.env`，所以打包后应在 runtime 根目录另行创建该文件。启动时凭据只传给当前 PowerShell 子进程及其启动链；脚本退出后恢复调用前的环境变量，不把密钥放入参数或日志。若模型连接尚未启用，脚本会等待你打开终端打印的一次性本地控制台链接，在“ChatGPT 连接”页明确确认并启用；完成后脚本自动运行 doctor 并启动隧道。该步骤只启用连接级工具发现，不会登记目录或授予工作区读写权；请在“工作区”页登记目录并分别勾选所需工具。开发源码目录对应脚本为 `scripts/windows/Start-LocalWebGPT.ps1`。

可用 `-ValidateOnly` 单独检查 `.env` 格式；该模式不启动 daemon 或隧道，也不显示凭据。

停止已运行服务时，在另一个 PowerShell 窗口执行源码目录的 `.\scripts\windows\Stop-LocalWebGPT.ps1`，或 runtime 根目录的 `.\Stop-LocalWebGPT.ps1`；等待启动窗口返回提示符。命令不按 PID 杀进程；服务先拒绝新操作并等待在途处理器结束。若脚本未收到 `STOPPING` 确认（例如 daemon 是不支持管道停止协议的旧版），不要强杀；回到启动时的原终端按 Ctrl+C 并等待退出。若停在一次工具调用期间，重连后查询 `change_get` 确认状态，勿盲目重复应用。

## 升级与卸载限制

升级前的数据库保护已接入启动链，但 LWB-040 仍未完成：V1 尚无自动升级切换器、签名安装器或真实安装/升级验收。runtime 目录现提供带工作区重叠检查的卸载脚本；卸载会保留受保护状态库与所有工作区。

当本机已有较旧 schema 的状态库时，daemon 在单实例锁与受保护目录检查之后、打开迁移连接之前，会：

1. 只读核对迁移记录与校验和。当前算法会规范化 SQL 引号外的格式空白与注释，因此排版调整不会阻断升级；SQL 字符串/引用标识符变化、未知版本或不匹配校验和仍会拒绝继续。旧版原始文本 checksum（包括 v8 一格缩进调整前的历史值）也在兼容表中接受。
2. 若存在 `QUEUED`、`VALIDATING`、`APPLYING` 或 `RECOVERY_REQUIRED` 操作，拒绝升级；先用兼容版本在本机完成恢复，再退出旧进程。
3. 否则用 SQLite 在线备份 API 在 `%LOCALAPPDATA%\LocalWorkspaceBridge\db` 生成快照（涵盖 WAL 中已提交内容），检查 `quick_check` 和迁移元数据，再运行 schema 迁移。只有验证过的快照才会以 `.pre-migration-...sqlite` 名称保留。

如果备份无法创建或验证，daemon 会在迁移前停止，原状态库不变；如果迁移后续失败，预迁移快照仍会保留。不要在服务运行时手工覆盖状态库。

迁移前置检查与 schema 兼容性回归：

```powershell
node --import tsx --test tests/unit/database-upgrade.test.ts
```

当前测试覆盖旧库快照、未决恢复操作时阻断、缺失/当前库的快照跳过，以及旧程序遇到更高 schema 时拒绝打开且不改变数据库字节。

### 卸载 runtime（V1）

1. 先在控制台的恢复页检查是否有待处理/无法判定的恢复记录。若有，先保留 runtime 和本地状态目录，不要继续删除。
2. 在另一个 PowerShell 窗口，从 runtime 根目录运行 `.\Stop-LocalWebGPT.ps1`，等待启动窗口完全返回提示符。不要强杀进程。
3. 停止后，从 runtime 根目录启动一个**独立 PowerShell 进程**运行：

   ```powershell
   $uninstaller = Join-Path $PWD 'Uninstall-LocalWebGPT.ps1'
   pwsh.exe -NoProfile -File $uninstaller -ConfirmTargetRuntimeStopped
   ```

   脚本会在删除前再询问确认；`-WhatIf` 可预览而不删除。它会把精确 runtime 根目录的清理交给一个隐藏 helper，等待卸载 PowerShell 进程退出后才删目录；命令返回后请确认 runtime 目录已消失。默认检查 `%LOCALAPPDATA%\LocalWorkspaceBridge\db\bridge.sqlite`；若 daemon 使用了自定义 `LWB_HOME`，必须将 `-StateRoot` 指向**实际**状态根，例如 `-StateRoot 'D:\LocalWorkspaceBridge'`。

4. 若所选 runtime 与状态目录或任一登记工作区有路径重叠、工作区记录无法读取、目标像源代码仓库，或目标 runtime 自己的 tunnel-client 仍在运行，脚本会拒绝删除。路径重叠时先在控制台确认并处理对应 workspace grant；不要改用递归删除强行绕过。删除只作用于这个精确 runtime 目录；内含 reparse point 时只删 link 本身，不跟随到目标目录。

runtime 内 `.env` 会随目录一起删除，但值不会写进输出。受保护状态默认**保留**：数据库、快照、恢复记录、审计和本机凭证仍在 `%LOCALAPPDATA%\LocalWorkspaceBridge`；使用自定义 `LWB_HOME` 时，该目录同样保留。脚本不会清除或移动授权工作区内容。

卸载脚本的 Windows 临时夹具测试：

```powershell
node --import tsx --test tests/windows/uninstall-runtime.test.ts
```

该测试验证精确 runtime 删除、工作区和状态库保留、目标与登记工作区重叠时拒绝，以及 `.env` 值不进入输出；不会触碰真实安装或状态目录。LWB-040 仍 PARTIAL：真实安装路径卸载、自动升级切换和签名安装包尚未验收。

构建器要求 runtime 使用仓库外的新目录，旧运行目录与受保护状态分开；不要把 runtime 安装在任何授权工作区内部。
