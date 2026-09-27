# LWB-017 · 工具面与 MCP 适配器 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-017.ts`（退出码 0；**68 PASS / 0 FAIL / 4 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15 / PowerShell 7.6.6 /
护栏后端 `powershell-pinvoke`（`Microsoft Windows NT 10.0.26200.0`）/
夹具仓库 `tests/fixtures/generated/testrepo`（HEAD `5eefeeedc616b82927d6424c4d78e64a39c6b8dc`，
根身份由护栏当场问出：`volume=b0e2c2db file=0002000000672a7d fs=NTFS drive=fixed`）
**测试套件：** `tests/unit/daemon-tools.test.ts`（**34 例**，工具面与授权链）+
`tests/unit/mcp-adapter.test.ts`（**31 例**，真 MCP 客户端 + 内存传输）+
`tests/windows/mcp-adapter-e2e.test.ts`（**10 例**，真进程 + 真命名管道）；
全仓 `tests 902 / suites 148 / pass 902 / fail 0`
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **113 个文件**，未发现绕过（LWB-016 时为 98；见 §5 第 11 条的说明）
**变异验证：** 见 §3（把修好的那行改回去，4 条用例立刻失败；改回后全绿）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-016` 一致）。
下文引用的每条 `PASS` / `NOTE` / `NOT_RUN` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

---

## 0. 这一轮的证据是在什么装置上采的

本任务的验收标准里有一句容易读过去的话：「**工具结果符合 schema**」。
要让这句话可证伪，结果必须真的产生出来 —— 空目录、只有一个条目的目录
都会让结果里的数组恒为空，而一个恒为空的字段符合任何 schema。
因此证据脚本的装置里，**三段都是真的**：

```
真 MCP 客户端 ──stdio──▶ 真适配器进程 ──命名管道──▶ 真 IPC 服务端 ──▶ 真工具处理器
                                                                        │
                                                          真实 NTFS 夹具仓库 + 真实句柄护栏
```

```
== 装置：真实护栏 + 真实夹具仓库（不是桩） ==
PASS 护栏可用 — powershell-pinvoke；Microsoft Windows NT 10.0.26200.0 / PowerShell 7.6.6
PASS 护栏提供句柄级身份 — identity=true exclusive=true
NOTE 夹具根身份（由护栏当场问出） — volume=b0e2c2db file=0002000000672a7d fs=NTFS drive=fixed
NOTE 夹具 HEAD — 5eefeeedc616b82927d6424c4d78e64a39c6b8dc
NOTE 门禁（本次证据运行） — g0/native_guard/section3 全开 —— 见下面的「生产装配」对照
```

**必须同时读的一段：生产装配此刻的能力开关全部为假。**
ADR-003 §5.1 与 `docs/compatibility.md:65` 规定，§3 通过之前
`read_enabled` / `git_enabled` / `proposal_enabled` / `direct_write_enabled`
一律保持关闭。因此上面的「七个工具都可用」是**门禁开启的装置**上的结论，
不是本机现在的状态。脚本里专门有一段把生产状态摆出来：

```
== 生产装配对照：门禁全关时清单恰好两条 ==
PASS 门禁全关 ⇒ tools/list 只有 bridge_status 与 workspace_list — bridge_status、workspace_list
PASS 读取/Git 工具一个都没挂出（能力开关默认全关）
PASS 门禁全关 ⇒ bridge_status 自述四个能力开关全 false — read=false git=false write=false gates=false/false limitations=8
```

同理，本轮所有「工具真的读到了内容」的结论都采自**测试装置**；
「不得进入真实目录开发联调」这条约束没有被这次证据绕过 —— 夹具仓库是
生成出来的测试根，不是某个人真实的工作目录。

---

## 1. 验收标准逐条

### 验收标准 1 · 无控制平面方法出现在 `tools/list`

```
== 验收 1：无控制平面方法出现在 tools/list ==
PASS daemon 清单覆盖全部 12 个工具名 — entries=12
PASS daemon 清单里有 7 个可用 — bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff
PASS daemon 清单里没有控制面方法 — 命中 0 条
PASS MCP tools/list 恰好是七个已实现工具，且顺序与契约一致 — bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff
PASS MCP tools/list 里没有控制面方法 — 逐条核对 12 条路由，命中 0 条
PASS 工具描述里没有承诺未实现的控制面调用 — 无
PASS 七个工具的输入 schema 都声明 additionalProperties:false — 全部收窄
PASS 七个工具都挂出了 outputSchema — 全部挂出
PASS 七个工具都标注 readOnlyHint:true — 全部只读
NOTE 适配器日志 — tools/list：挂出 7 个工具（bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff）。
```

**这一条要两处都成立，因为「工具面」不是一个进程的事。**

- daemon 侧：`catalogFor` 遍历的是 `TOOL_NAMES`（12 个），
  `assertNoControlPlane` 在装配期再断言一次 —— 它遍历的同样是那 12 个名字，
  因此这条断言今天不可能为假；它的价值在于**换来源的那一天**
  （有人把清单换成一次 IPC 往返的返回值）会立刻失败。
- 适配器侧：`resolveSurface` 会拒绝任何落在 `CONTROL_PLANE_ROUTES` 里的名字，
  并且**整份清单**失败 —— 不是跳过那一个。原因是分叉只表现为
  「少了个工具」时在功能上看不出异常，而一个说不清自己有哪些工具的工具面
  不如一个明确报错的工具面。
- 「工具定义只来自本地契约」这条单向数据流是这一条验收标准的实现手段：
  名字从 daemon 来，定义从 `@lwb/contracts` 来。即使 daemon 的返回被改成
  任意内容，也**不可能**让一个不存在的工具或一个被放宽的 schema 出现在
  `tools/list` 里 —— 那些东西在适配器进程里没有来源。
- 最后三行是「描述不得暗示不可用的能力」的可机读版本：`change_*` 五个工具
  既不出现（11 个名字逐条核对），也不在别处的描述文字里被承诺；
  七个已实现的工具都带 `readOnlyHint: true`（它们**确实**都是只读的）。

### 验收标准 2 · 工具结果符合 schema，调用未知字段 / 无效枚举被拒绝

**（a）结果符合 schema —— 裁判是 MCP 客户端，不是本仓库。**

```
== 验收 2a：七个工具的结果符合 schema（裁判是 MCP 客户端） ==
PASS bridge_status 结果符合输出 schema — read=true git=true write=true gates=true/true limitations=2
PASS workspace_list 结果符合输出 schema — workspaces=1(directory/read_propose_apply_with_local_approval) truncated=false
PASS file_list 结果符合输出 schema — path=newline entries=4 next_cursor=null denied=0 excluded=0 incomplete=false
PASS text_search 结果符合输出 schema — matches=1 files=1 scanned=16 secret_files=1 denied=4
PASS file_read 结果符合输出 schema — sha256=0821ee357bb2…(64) 行=1–4 encoding=utf-8 newline=lf bytes=30 redacted=false editable=true
PASS git_status 结果符合输出 schema — branch=main head=5eefeeedc616…(40) entries=18 状态组合=absent/untracked added/unmodified unmodified/deleted unmodified/modified unmodified/unmodified 隐藏=4 limited_to_authorized=true
PASS git_diff 结果符合输出 schema — comparison=head_vs_worktree base=5eefeeedc616…(40) hunks=1 lines=10 old=408d5d4c504c…(64) new=f6672ba4b315…(64) binary=false redacted=false truncated=false
PASS file_read 的 sha256 等于夹具清单的期望值 — 0821ee357bb2…(64) vs 清单 0821ee357bb2…(64)
```

- **校验发生在客户端**：SDK 的 `Client.callTool` 会拿 `tools/list` 里那份
  `outputSchema`（由 zod 转成 JSON Schema）校验 `structuredContent`，
  不符就抛 `InvalidParams`。自己调处理函数只是自己检查自己，
  因此这里每一句都经过一个真的 `Client`。
- **摘要里的计数不是空值**：`entries=4`（`newline/` 下四个换行风格文件）、
  `matches=1`（搜索锚点只在 `src/main.ts` 里）、`entries=18` 与四种状态组合
  （`absent/untracked`、`added/unmodified`、`unmodified/deleted`、
  `unmodified/modified`）、`hunks=1 lines=10`。这些数字来自磁盘。
- **最后一行是形状之外的判据**：`file_read` 的 `sha256` 必须等于
  夹具清单（`manifest.json`，由生成器写的）里的期望值。
  没有这一条，一个「形状正确、内容错误」的工具面也能通过上面七行。
- **`secret_files=1 denied=4`**：搜索扫描到了 1 个秘密文件与 4 个被拒文件，
  它们**计入统计但不返回内容** —— 计数与内容的分开是文件搜索那条链的责任，
  这里只把它作为「结果里出现的数字确实来自真实判定」的旁证。

**（b）未知字段 / 身份字段 / 无效枚举 / 类型不符 / 越界数值 —— 逐类被拒。**

```
== 验收 2b：未知字段、身份字段、无效枚举一律被拒绝 ==
PASS 未知字段 ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=verbose
PASS 未知字段（顶层多一个键） ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=recursive
PASS 身份字段 approved ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=approved
PASS 身份字段 user_id / session_id / conversation_label ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=user_id,session_id,conversation_label
PASS 无效枚举 ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=comparison
PASS 类型不符 ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=start_line
PASS 越界数值 ⇒ INVALID_ARGUMENT — code=INVALID_ARGUMENT reason=INPUT_SCHEMA_VIOLATION field=depth
PASS 伪造的身份字段不会改变授权结论 — code=INVALID_ARGUMENT
```

- 七类都给出**出错字段名**（`field=`）。未知字段那一类的 `path` 在 zod 里是空数组，
  只看 `path` 会得到一句「参数不合法」而不带字段名 —— 而调用方唯一能做的
  修正就是猜。`parseInput` 因此专门把 `unrecognized_keys` 的键列出来。
- **`approved: true` 不是授权证据**（ADR-003 §4）：它在这里被
  `strictObject` 直接拒绝，连到达授权判定的机会都没有。
  `user_id` / `session_id` / `conversation_label` 同样。
- 最后一行是这条约束的**另一种问法**：一个本来就会被拒绝的越权读取
  （对方工作区），加上 `approved: true` 之后，被拒绝的仍然是「参数不合法」，
  而不是「因为它说 approved 就放行」。拒绝对同一个调用加了什么字段不敏感 ——
  这正是「参数不参与授权」这句话的样子。

**（c）失败是工具结果，且错误码说实话。**

```
== 验收 2c：失败是工具结果，且错误码说实话 ==
PASS 硬拒绝文件（.env） ⇒ POLICY_DENIED — code=POLICY_DENIED request_id=req-evidence details={"policy_check":"file_rules","policy_reason":"HARD_DENY_RULE","hard_deny_rule":"HD-ENV","failure_count":1,"request_id":"req-evidence"}
PASS 硬拒绝文件（.env） 的载荷符合失败契约 — category=business auto_retry=never details={…}
PASS 硬拒绝文件（id_rsa） ⇒ POLICY_DENIED — code=POLICY_DENIED request_id=req-evidence details={"policy_check":"file_rules","policy_reason":"HARD_DENY_RULE","hard_deny_rule":"HD-SSH-KEY","failure_count":1,"request_id":"req-evidence"}
PASS 未授权工作区 ⇒ WORKSPACE_NOT_GRANTED — code=WORKSPACE_NOT_GRANTED request_id=req-evidence details={"request_id":"req-evidence"}
PASS 不存在的相对路径 ⇒ NOT_FOUND — code=NOT_FOUND request_id=req-evidence details={"winfs_code":"NOT_FOUND","win32_error":2,"request_id":"req-evidence"}
PASS 逃逸路径 ⇒ PATH_UNSAFE — code=PATH_UNSAFE request_id=req-evidence details={"winfs_code":"PATH_UNSAFE","win32_error":0,"request_id":"req-evidence"}
PASS 未实现的工具 ⇒ UNSUPPORTED_OPERATION — code=UNSUPPORTED_OPERATION request_id=(适配器本地) details={"outcome_unknown":false,"ipc_code":"UNKNOWN_OPERATION"}
PASS 失败信封确实不符合成功 schema — ok=false 成功 schema 判定=false
PASS 同一条失败经适配器后仍然是 POLICY_DENIED（不是 INTERNAL_ERROR） — code=POLICY_DENIED
```

- **业务失败以 `isError: true` 的工具结果返回，且不带 `structuredContent`。**
  输出 schema 描述的是成功那一种结果；把失败也塞进去会让
  「结果符合 schema」变成「两个分支之一符合」。
- **`request_id` 原样到达模型载荷**（`details.request_id`）：它是 daemon 那条
  审计记录的主键。LWB-018 的第一条验收是「可回答某次工具调用读取和返回了
  哪些文件范围」—— 两个 ID 对不上时，排查者会以为日志缺了，而不会想到 ID 被换过。
  适配器本地合成的错误（连不上 daemon）没有这个 ID，那时也确实不存在
  daemon 侧的审计记录。
- **`details` 里带的是可机读的理由**：`hard_deny_rule: HD-ENV` / `HD-SSH-KEY`
  而不是一段自由文本；`winfs_code` / `win32_error` 让人能直接对上护栏的答复。
- **`失败信封确实不符合成功 schema` 这一行是承载性的**：它把
  「先认失败信封、再认成功信封」这个顺序从「看起来更稳妥」变成
  「不这样就是错的」。理由见 §3。

### 验收标准 3 · 两条配置不同的连接不能读取对方工作区

```
== 验收 3：两条配置不同的连接不能读取对方工作区 ==
PASS 适配器连接读得到自己工作区的文件 — sha256=0821ee357bb2…(64) 行=1–4 encoding=utf-8 newline=lf bytes=30 redacted=false editable=true
PASS 适配器连接列得到自己工作区的目录 — path=src entries=3 next_cursor=null denied=0 excluded=0 incomplete=false
PASS 读到的内容与夹具清单一致 — 0821ee357bb2…(64)
PASS 另一条连接读得到它自己的工作区（因此下面的拒绝不是空转） — ok=true
PASS file_read：适配器连接读不到对方工作区 — code=WORKSPACE_NOT_GRANTED
PASS file_list：适配器连接读不到对方工作区 — code=WORKSPACE_NOT_GRANTED
PASS text_search：适配器连接读不到对方工作区 — code=WORKSPACE_NOT_GRANTED
PASS git_status：适配器连接读不到对方工作区 — code=WORKSPACE_NOT_GRANTED
PASS 反向（另一条连接读适配器工作区）同样被拒 — code=WORKSPACE_NOT_GRANTED
PASS 被拒绝的读取不返回任何文件内容 — structuredContent=缺席
```

**「读不到对方的工作区」这句话只有在「读得到自己的」成立时才有内容。**
没有前四行的话，一个把所有读取都拒掉的工具面也能让后面五行全绿。
装置里两个工作区的授权是**交叉缺失**的（连接 A 只被授权 ws-A，
连接 B 只被授权 ws-B），因此这条隔离是默认状态而不是专门构造出来的场景。

反向那一句走的是 daemon 的**另一条连接上下文**：适配器进程手上只有
自己那把凭证，它也只能以自己那条连接说话 —— 单向的隔离可能只是
「有一条连接恰好没被授权」。

---

## 2. 进程级链路与启动路径

### 2.1 真进程 + 真命名管道

```
== 进程级链路：真客户端 ←stdio→ 真适配器进程 ←命名管道→ 真 IPC 服务端 → 真护栏 ==
PASS 适配器与 daemon 完成握手 — 事件数=1
PASS 跨进程的 tools/list 与进程内一致 — bridge_status、workspace_list、file_list、text_search、file_read、git_status、git_diff
PASS 跨进程读取的字节与夹具清单一致 — sha256=0821ee357bb2…(64) 行=1–4 encoding=utf-8 newline=lf bytes=30 redacted=false editable=true
PASS 跨进程的硬拒绝仍是 POLICY_DENIED — code=POLICY_DENIED
PASS 协议流干净（客户端还能解析下一条消息）
PASS 适配器日志不含凭证 — 2 行 stderr
NOTE 适配器 stderr — 适配器已就绪：{"pipe_name":"\\\\.\\pipe\\lwb-evidence-017-31644-1790331675224","connection_id":"conn-adapter","adapter_version":"0.1.0-evidence","secret_length":38}
```

- 进程是 `node --import tsx apps/mcp-adapter/src/main.ts` 拉起来的；
  传输是 MCP 的 stdio，管道是 Windows 命名管道，握手由 `attachSocket` 完成。
- **「stdout 上只有协议消息」这句话由「客户端一路解析到最后一条」证明**：
  `initialize`、每一次 `listTools` / `callTool`、最后的 `ping` 都是 stdout 上的帧。
  进程往 stdout 写过任何别的东西，这些调用中的某一次就已经解析失败了。
  （`protectStdout()` 在**读配置之前**执行，也正是为了这件事：配置加载失败时
  写的那句 stderr 不能落进协议流。）
- **日志里没有凭证**，只有形状与长度（`secret_length: 38`）。

### 2.2 启动失败要说清是哪一步

```
== 启动失败：说清哪一步失败，且不写脏 stdout ==
PASS 缺 LWB_CONNECTION_ID ⇒ 退出码 2 — 实际 2；stderr 首行：适配器启动失败：缺少必需的环境变量 LWB_CONNECTION_ID。
PASS 缺 LWB_CONNECTION_ID ⇒ stdout 为空 — stdout 长度=0
PASS 缺 LWB_CONNECTION_ID ⇒ stderr 指出原因 — LWB_CONNECTION_ID
PASS 缺 LWB_CONNECTION_ID ⇒ stderr 不回显凭证
PASS daemon 不可达 ⇒ 退出码 1 — 实际 1；stderr 首行：适配器无法连接本地 daemon（IpcUnavailableError）；配置：{"pipe_name":"\\\\.\\pipe\\lwb-evidence-missing-31644","connection_id":"conn-adapter","adapter_version":"0.0.0","secret_length":38}。请确认 daemon 正在运行。
PASS daemon 不可达 ⇒ stdout 为空 — stdout 长度=0
PASS daemon 不可达 ⇒ stderr 指出原因 — 无法连接本地 daemon
PASS daemon 不可达 ⇒ stderr 不回显凭证
```

连不上 daemon 就**退出**（不是挂在那里把失败摊薄成每次调用都失败）。
配置缺失是 2、连不上是 1：两个不同的退出码对应两个不同的排查方向。
两条路径的 stdout 都是空的 —— 启动失败时一个字节都不能写协议流，
否则客户端读到的是「协议损坏」而不是「适配器没起来」。

---

## 3. 本轮修掉的一个真缺陷（以及它为什么不是「看起来更稳妥」）

**缺陷：** `toCallToolResult` 拿**成功信封**的 schema 去解析 daemon 的返回，
于是每一次业务失败（策略拒绝、未授权、超限）都被折成
`INTERNAL_ERROR`（「本地服务内部错误」）。真实的答案是「被拒绝了」，
而排查方向被整个引到反的方向去。

**修法：** 在 `@lwb/contracts` 里给失败载荷与失败信封各写一条 schema
（`BRIDGE_ERROR_PAYLOAD` / `ERROR_ENVELOPE`，与 `ErrEnvelope` / `BridgeErrorPayload`
双向核对），适配器**先认失败信封、再认成功信封**。

**变异验证（本轮实跑）：** 把那行改回 `if (false && failure.success)`，
两套用例立刻失败 4 条，且失败的恰好是断言「业务失败不被折成内部错误」的那些：

```
    not ok 2 - daemon 的失败信封被翻成工具结果，而不是 INTERNAL_ERROR
    not ok 5 - 身份字段到达 daemon 后被拒绝：结果里是可机读的输入违约，不是内部错误
# tests 31
# pass 29
# fail 2

    not ok 4 - 硬拒绝文件：跨进程读 .env 也是 POLICY_DENIED，理由是可机读的规则名
    not ok 5 - 两条配置不同的连接仍然读不到对方的工作区（这一条跨了进程）
# tests 10
# pass 8
# fail 2
```

改回后两套重新全绿（`31/31`、`10/10`）。
同一条判断在证据脚本里还有一处**不依赖变异**的表述：

```
PASS 失败信封确实不符合成功 schema — ok=false 成功 schema 判定=false
PASS 同一条失败经适配器后仍然是 POLICY_DENIED（不是 INTERNAL_ERROR） — code=POLICY_DENIED
```

第一行证明的是「这个分支有作用」：拿成功 schema 套同一份失败信封**必须失败**，
否则那个 `if` 就是个恒真分支，而缺陷会一直躺在那里。

---

## 4. 步骤对照（方案 LWB-017）与未执行项

| 方案步骤 | 本轮状态 | 依据 |
| --- | --- | --- |
| 1. 实现 `bridge_status`、`workspace_list`、`file_list`、`text_search`、`file_read`、`git_status`、`git_diff` | **完成** | `apps/daemon/src/tools/`（6 个文件）；七个工具各在验收 2a 里跑过一次真读取 |
| 2. 通过已认证 IPC 绑定固定连接身份，不接受模型覆盖身份字段 | **完成** | 验收 2b 的四个身份字段用例；`conn-adapter` 的握手在 §2.1 里被记录 |
| 3. 按当前 SDK 实现输入/输出 schema、错误契约、准确 annotations；stdio 标准输出仅为协议消息 | **完成** | 验收 1 的三行（`additionalProperties:false` / `outputSchema` / `readOnlyHint`）；§2.1 的 `ping` |
| 4. 以 Inspector 和真实 ChatGPT 账号验证工具选择、失败结果、版本协商和元数据刷新 | **未执行** | 见下 |

```
== 未执行项（不得记为通过） ==
NOT_RUN ChatGPT 网页端发现并调用这些工具 — LWB-002 BLOCKED：需要真实 ChatGPT 账号与 Secure MCP Tunnel 凭证；本机没有。MCP Inspector 的成功不能替代它
NOT_RUN MCP Inspector 手工验证（工具选择、失败结果、版本协商、元数据刷新） — 未执行：本轮证据只到「真 MCP 客户端 + 真进程 + 真管道」这一层
NOT_RUN Secure MCP Tunnel 的端到端链路 — LWB-002 BLOCKED：无隧道凭证
NOT_RUN 两条**配置不同**的连接在生产装配下的隔离 — 生产装配门禁全关，读取类工具一个都不挂出；本轮隔离证据采自门禁开启的装置
```

步骤 4 的三件事一件都没有被替代：**MCP Inspector 的成功不能替代 ChatGPT 网页端**，
而「真 MCP 客户端 + 真进程 + 真管道」只是把能自动化的那一半测到了底。
网页端的**工具选择行为**（模型看描述决定调哪个）、**版本协商**与
**元数据刷新**都还没有被观察过，因此 LWB-002 维持 BLOCKED。

---

## 5. 偏差（实现与本任务书面要求的差异，逐条）

1. **生产能力开关全关**（ADR-003 §5.1 / `docs/compatibility.md:65`）。
   本轮所有正向证据采自门禁开启的装置；生产装配下 `tools/list` 恰好两条。
   这不是降级，是「平台未验证之前不进入真实目录开发联调」这条约束本身。
2. **`SERVICE_UNAVAILABLE` 是 LWB-017 新加进契约的错误码**（`errors.ts`）。
   它对应 IPC 层的三种失败（`IPC_UNAVAILABLE` / `IPC_INTERRUPTED` / `TIMEOUT`），
   而原来的错误码表里没有「本地服务此刻不可用」这一档，
   硬套 `INTERNAL_ERROR` 会把「daemon 没在跑」说成「本地服务有 bug」。
3. **`tools.catalog` 返回信封而不是裸的 `{tools}`**。它是控制面操作，
   契约要求控制面与工具用同一种信封；适配器因此只做形状判别，
   不把失败信封交给调用方（`tools/list` 要么挂出完整清单，要么什么都不挂）。
4. **`normalizeToolArguments` 今天跑不到**（SDK 自己的 schema 已经拒绝了
   非对象参数）。它被单独导出并**直接测**，理由是它约束的是「本进程答应过的事」——
   SDK 的 schema 是否永远这么严不是本进程能决定的。它在一条覆盖不到的分支里，
   因此值得有一条直接的用例。
5. **适配器侧的参数拒绝不进审计**：参数不合法在适配器里就被拒了，
   那时 daemon 根本没有收到这条调用，也就没有审计记录。
   与「每一次拒绝都有本地审计可见」这个目标有差距，记在这里。
6. **同一 audience 凭证之间不可区分**：两条都用 `mcp-adapter` 凭证的连接
   在本机看来是同一条身份。这是已知非目标（单用户、单适配器进程）。
7. **`paused` 恒为 false**（没有全局暂停状态库）、
   **`text_search` 的 `cancelled` 恒为 false**（没有取消通道进入搜索）。
   两者都是契约里的字段，当前没有对应的实现来源，因此恒为各自的中性值。
8. **`change_*` 的 `path` 仍是 `min(1)`**：单文件工作区因此表达不出变更。
   这属于 LWB-019，本任务不动它。
9. **`targetPath` 与 `validateRelativePath` 的 `EMPTY` 边界含义不同**
   （前者允许空串表示根，后者把它当语法错误）。两者不在同一条路径上，
   但共用同一个名字，记在这里以防后来者混用。
10. **本任务新增了 `ERROR_ENVELOPE` 与 `BRIDGE_ERROR_PAYLOAD` 两条契约**，
    它带来一个可见的形状变化：失败载荷里现在会多一个
    `details.request_id`。它是本地审计的关联 ID，不是凭证、也不携带授权含义。
11. **`apps/daemon/src/gates.ts` 落在静态导入检查的两个名单之外**
    （既不在 `BUSINESS_PREFIXES` 也不在 `ALLOWED_PREFIXES`），
    按该脚本自己的规则（`isBusiness && !isAllowed`）会被**静默跳过**。
    这不是本任务引入的，本任务只是让这个文件第一次存在。它今天是纯常量模块
    （不 import 任何东西），但那条「新增一个包时必须把它写进其中一个列表」
    的提醒在它身上落了空 —— 记在这里以免被当成「已经检查过了」。

---

## 6. 交付物

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `packages/contracts/src/tool-outputs.ts` | 401 | 七个工具的输出 schema（含成功/失败两种信封），每条后面跟一次编译期双向核对 |
| `packages/contracts/src/tool-catalog.ts` | 89 | `tools.catalog` 的输出契约 |
| `packages/contracts/src/wire-shape.ts` | 129 | schema ↔ TypeScript 类型的双向核对机器 |
| `packages/contracts/src/tools.ts` | （改） | 12 个工具的输入 schema 与 annotations |
| `apps/daemon/src/tools/{index,handlers,operations,catalog,access,errors}.ts` | 1294 | 工具面：装配、处理器、操作表、可用性清单、授权链、错误消毒 |
| `apps/daemon/src/gates.ts` | 136 | 门禁常量与能力开关推导（默认全关） |
| `apps/mcp-adapter/src/{main,server,surface,config}.ts` + `stdio/guard.ts` | 688 | 适配器进程：stdio 保护、清单解析、转发与翻译 |
| `tests/tools/{harness,fixture-ops}.ts` | 708 | 测试装置：真实 sqlite 状态库 + 可换真护栏的探测器/后端 |
| `tests/unit/daemon-tools.test.ts` | 846 | 工具面与授权链（34 例） |
| `tests/unit/mcp-adapter.test.ts` | 799 | 适配器与真 MCP 客户端（31 例） |
| `tests/windows/mcp-adapter-e2e.test.ts` | 348 | 真进程 + 真命名管道（10 例） |
| `scripts/evidence/lwb-017.ts` | 981 | 本文件引用的全部证据 |

**未被本任务改动**：路径与句柄层（`native/winfs`）、策略（`packages/policy`）、
文件读取与搜索（`packages/files` / `packages/search`）、Git（`packages/git-reader`）、
IPC 传输（`packages/ipc`）。工具面是它们的**调用方**；本轮没有为了让工具面
好看而放宽其中任何一条判定。
