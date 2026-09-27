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

升级器和卸载器尚未交付。不要在已有安装目录上覆盖升级，也不要通过删除运行目录来清理 LocalWebGPT 状态。当前构建器拒绝使用已存在的输出目录，因此每个构建必须使用一个新的、明确选择的路径。数据库备份、schema 兼容检查、未决恢复任务处理、服务停止与状态保留策略仍待实现和验收。
