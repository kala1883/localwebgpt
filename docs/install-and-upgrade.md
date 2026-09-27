# Windows 安装与升级

## 当前状态

仓库提供一个 Windows x64 runtime 目录构建器：

```powershell
.\packaging\windows\build-runtime.ps1 -OutputDirectory "$env:LOCALAPPDATA\Programs\LocalWebGPT"
```

这条构建命令从源码仓库运行；生成的 runtime 目录不包含 `packaging/` 构建脚本。

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

`.env` 被 Git 忽略。构建脚本不会复制源码 `.env`，所以打包后应在 runtime 根目录另行创建该文件。启动时凭据只传给当前 PowerShell 子进程及其启动链；脚本退出后恢复调用前的环境变量，不把密钥放入参数或日志。若模型连接尚未启用，脚本会等待你打开终端打印的一次性本地控制台链接，在“ChatGPT 连接”页明确确认并启用；完成后脚本自动运行 doctor 并启动隧道。该步骤只启用连接级工具发现，不会登记目录或授予工作区读写权；请在“工作区”页登记目录并分别勾选所需工具。开发源码目录对应脚本为 `packaging/windows/Start-LocalWebGPT.ps1`。

可用 `-ValidateOnly` 单独检查 `.env` 格式；该模式不启动 daemon 或隧道，也不显示凭据。

停止已运行服务时，在另一个 PowerShell 窗口执行源码目录的 `.\packaging\windows\Stop-LocalWebGPT.ps1`，或 runtime 根目录的 `.\Stop-LocalWebGPT.ps1`；等待启动窗口返回提示符。命令不按 PID 杀进程；服务先拒绝新操作并等待在途处理器结束。若停在一次工具调用期间，重连后查询 `change_get` 确认状态，勿盲目重复应用。

## 升级与卸载限制

升级前的数据库保护已接入启动链，但 LWB-040 仍未完成：升级器、自动恢复备份和签名安装器尚未交付/验收。V1 暂无自动卸载器；以下是保留本地状态的手工卸载流程。

当本机已有较旧 schema 的状态库时，daemon 在单实例锁与受保护目录检查之后、打开迁移连接之前，会：

1. 只读核对迁移记录与校验和；遇到未知/不一致 schema 时拒绝继续。
2. 若存在 `QUEUED`、`VALIDATING`、`APPLYING` 或 `RECOVERY_REQUIRED` 操作，拒绝升级；先用兼容版本在本机完成恢复，再退出旧进程。
3. 否则用 SQLite 在线备份 API 在 `%LOCALAPPDATA%\LocalWorkspaceBridge\db` 生成快照（涵盖 WAL 中已提交内容），检查 `quick_check` 和迁移元数据，再运行 schema 迁移。只有验证过的快照才会以 `.pre-migration-...sqlite` 名称保留。

如果备份无法创建或验证，daemon 会在迁移前停止，原状态库不变；如果迁移后续失败，预迁移快照仍会保留。不要在服务运行时手工覆盖状态库。

### 手工卸载（V1）

1. 先在控制台的恢复页检查是否有待处理/无法判定的恢复记录。若有，先保留 runtime 和本地状态目录，不要继续删除。
2. 在另一个 PowerShell 窗口，从**当初 `-OutputDirectory` 指定的 runtime 根目录**运行 `.Stop-LocalWebGPT.ps1`；等待启动窗口完全返回提示符。不要强杀进程。
3. 只删除那个精确的 runtime 输出目录；不要删除它的父目录，不要删除 `%LOCALAPPDATA%\LocalWorkspaceBridge`，也不要删除任何已授权工作区。安装时应把 runtime 放在与工作区无重叠的独立目录（推荐 `%LOCALAPPDATA%\Programs\LocalWebGPT`）。如果不能确认路径没有与工作区重叠，就先不要删除。
4. runtime 目录中的 `.env` 随 runtime 一起移除（其中的 tunnel runtime key 不会写进日志）。受保护本地状态默认**保留**：数据库、快照、恢复记录、审计和本机凭证仍在 `%LOCALAPPDATA%\LocalWorkspaceBridge`；若启动时使用自定义 `LWB_HOME`，保留该目录。V1 不提供自动清除状态/快照的卸载选项，因为待恢复操作可能依赖这些唯一字节。

这套流程不触碰已授权工作区，但仍需人工确认 runtime 路径无重叠；自动卸载器与长时升级/卸载验收仍未完成。构建器要求 runtime 使用仓库外的新目录，旧运行目录与受保护状态分开。
