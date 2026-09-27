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
```

`.env` 被 Git 忽略。构建脚本不会复制源码 `.env`，所以打包后应在 runtime 根目录另行创建该文件。启动时凭据只传给当前 PowerShell 子进程及其启动链；脚本退出后恢复调用前的环境变量，不把密钥放入参数或日志。若模型连接尚未启用，脚本会等待你打开终端打印的一次性本地控制台链接，在“ChatGPT 连接”页明确确认并启用；完成后脚本自动运行 doctor 并启动隧道。该步骤仅启用连接级工具发现，不会登记任何目录、授予全盘权限或更改 G0/G2/G3 门禁。开发源码目录对应脚本为 `packaging/windows/Start-LocalWebGPT.ps1`。

可用 `-ValidateOnly` 单独检查 `.env` 格式；该模式不启动 daemon 或隧道，也不显示凭据。

## 升级与卸载限制

升级前的数据库保护已接入启动链，但 LWB-040 仍未完成：升级器、卸载器、自动恢复备份和签名安装器尚未交付/验收。

当本机已有较旧 schema 的状态库时，daemon 在单实例锁与受保护目录检查之后、打开迁移连接之前，会：

1. 只读核对迁移记录与校验和；遇到未知/不一致 schema 时拒绝继续。
2. 若存在 `QUEUED`、`VALIDATING`、`APPLYING` 或 `RECOVERY_REQUIRED` 操作，拒绝升级；先用兼容版本在本机完成恢复，再退出旧进程。
3. 否则用 SQLite 在线备份 API 在 `%LOCALAPPDATA%\LocalWorkspaceBridge\db` 生成快照（涵盖 WAL 中已提交内容），检查 `quick_check` 和迁移元数据，再运行 schema 迁移。只有验证过的快照才会以 `.pre-migration-...sqlite` 名称保留。

如果备份无法创建或验证，daemon 会在迁移前停止，原状态库不变；如果迁移后续失败，预迁移快照仍会保留。当前没有自动回滚/恢复命令或快照清理策略；不要在服务运行时手工覆盖状态库，也不要删除运行目录来“卸载”。构建器仍要求每次安装到一个全新的、仓库外路径，旧运行目录和用户状态保持分开。
