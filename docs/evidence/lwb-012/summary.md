# LWB-012 · 控制平面与本地授权 — 证据

**采集方式：** `node --import tsx scripts/evidence/lwb-012.ts`（退出码 0；**50 PASS / 0 FAIL / 4 NOT_RUN**）
**采集环境：** Windows 11 Home China 10.0.26200 / Node v22.20.0 / tsx 4.23.15
**测试套件：** `tests/unit/control-plane.test.ts`（**74 项全部通过**）；全仓 `tests 567 / pass 567 / fail 0`
**静态检查：** `npx tsc --noEmit` 退出码 0；`node scripts/check-fsguard-imports.mjs` — **79 个文件**，未发现绕过（LWB-011 时为 66）
**原始日志：** 未入库（`*.log` 在 `.gitignore` 中，与 `lwb-006` ~ `lwb-011` 一致）。
下文引用的每条 `PASS` / `NOT_RUN` 行均为运行输出的**逐字**摘录，本文件不依赖那份日志才可读。

---

## 1. 验收标准逐条

### 验收标准 1 · 恶意网页请求不能修改工作区或批准修改

```
NOTE 监听地址 — 127.0.0.1:13076（端口由系统分配；绑定后复核 address.address）
PASS 拒绝：跨站 fetch（Origin 是攻击者站点） — HTTP 403
PASS 拒绝：DNS rebinding（Host 是攻击者域名，连接落在同一套接字上） — HTTP 403
PASS 拒绝：sandbox iframe / data: 页面（Origin: null） — HTTP 403
PASS 拒绝：缺 Origin（非浏览器客户端或旧式表单） — HTTP 403
PASS 拒绝：HTML 表单跨站提交（application/x-www-form-urlencoded 是简单请求） — HTTP 403
PASS 拒绝：multipart/form-data（同样是简单请求类型） — HTTP 403
PASS 拒绝：同站不同端口（另一个本地服务伪造的请求） — HTTP 403
PASS 拒绝：浏览器已标记跨站（Sec-Fetch-Site: cross-site） — HTTP 403
PASS 拒绝：缺 CSRF 令牌（只有 cookie） — HTTP 403
PASS 拒绝：缺一次性 nonce（绕开审核直接改） — HTTP 403
PASS 拒绝：绝对形式请求目标（把控制 API 当代理用） — HTTP 400
PASS 拒绝：查询串里夹带凭证 — HTTP 400
PASS 没有任何一条恶意请求到达工作区 handler（拒绝发生在判定层，不在业务层） — handler 调用次数 0
PASS 恶意请求全部被拒：12 条 — …
PASS 对照：同一个监听地址上、不查 Host/Origin/CSRF/nonce 的实现，这些请求全部会成功 — 12/12 条被接受
PASS 对照：同一份内容、来源正确的请求会成功（因此上面的拒绝不是"谁来都拒"） — HTTP 200
PASS OPTIONS 不被实现（不实现 CORS 预检本身就是一道防线） — HTTP 405
PASS 响应里没有任何 Access-Control-Allow-* 头 — 无
PASS 每个响应都带 no-store 与 nosniff — cache-control=no-store x-content-type-options=nosniff
PASS Host 判定排在路由之前：非法 Host 下，存在与不存在的路径响应完全相同（枚举不出接口表） — 两者均为 HTTP 403、响应体逐字相同
PASS CONNECT 不产生隧道 — HTTP 0、转发字节数 0
PASS 从非回环地址（198.18.0.1）连不上控制 API — 连接被拒
```

**这一条的证据为什么用原始套接字采集，而不是 `fetch`。** 攻击者控制的正是报文的字节。
`Host`、`Origin`、`Cookie` 属于 fetch 的**禁止头**，绝对形式请求目标与 `CONNECT`
更不是 fetch 能表达的概念 —— 用 `fetch` 去测「攻击者做不到什么」，等于**测了一个
攻击者不会用的接口**：一个用 `fetch` 写的"跨站请求"用例即使通过，也只说明
「fetch 发不出这个请求」，而不说明「服务端会拒绝它」。因此上面 12 条恶意请求
全部是手写 HTTP/1.1 报文经 `node:net` 发出的。

**`Host` 是 DNS rebinding 的主要防线，不是"顺手加的头部检查"。** 攻击者把
`evil.com` 解析到 `127.0.0.1` 后，浏览器认为页面与请求**同源**，同源策略不再拦它。
此时唯一在服务端可见的痕迹就是 `Host: evil.com:PORT` —— 两条连接落在同一个
监听套接字上。也正因为它承担这个责任，接受的主机名必须是**一个**、且是绑定的那个
字面量：多接受一个拼写就多一条解析路径。

**"缺头就放行"这个陷阱已经关掉，且方向是 fail-closed。** 变更类请求缺 `Origin`
一律拒绝，代价是 `curl` 之类也要显式带上 `Origin` —— 这个代价是**故意**的：
控制平面的变更操作应当经过浏览器里的控制台，一个不带 `Origin` 的变更请求
没有正当来源。（这一点在采集时真的咬到了一次，见 §4.5。）

**强制 `application/json` 把跨站变更从「到达后被拒」变成「发不出去」。**
HTML 表单只能发出 `application/x-www-form-urlencoded`、`multipart/form-data`、
`text/plain` 三种 Content-Type，也只有这三种属于"简单请求"、可以不发预检就跨站发出。
强制 JSON 意味着任何跨站伪造的变更请求**必然先触发预检**，而本服务从不回应
CORS 预检 —— 于是它在发出前就被浏览器拦下。上面两条表单类型的请求在
**服务端**同样被拒（403），两道都在。

### 验收标准 2 · MCP 连接凭证不能调用控制 API

```
NOTE 控制平面路由表（穷尽遍历） — DELETE /api/session | GET /api/status | POST /api/nonces | POST /api/session | POST /api/workspaces/describe | POST /api/workspaces/list | POST /api/workspaces/pause | POST /api/workspaces/register | POST /api/workspaces/relocate | POST /api/workspaces/remove | POST /api/workspaces/resume | POST /api/workspaces/reverify
PASS 每一条控制路由：要么在免鉴权清单里，要么要求一个模型侧拿不到的能力 — 12 条路由；免鉴权且不在清单里的 0 条；模型侧可获得能力的 0 条
PASS 免鉴权路由只有两条，且都与会话建立/登出有关 — POST /api/session | DELETE /api/session
PASS 要求 tools.read（模型侧也有）的控制路由注册不出来 — register() 抛错
PASS 没有能力要求又不在免鉴权清单里的路由注册不出来 — register() 抛错
PASS 通配路径注册不出来（通配路由等于一个转发器） — register() 抛错
PASS 有控制操作没被分类为变更类/只读类时，控制平面拒绝装配 — …
PASS 「绝不授予模型」的能力清单与路由实际用到的能力一致 — 路由用到：audit.read, approvals.decide, workspaces.manage
PASS 把适配器那一侧的凭证素材当 cookie/请求头送进来，一律 401（没有会话，也没有别的入口） — …
PASS 形状正确但没有签发过的启动令牌换不到会话，且是 403 而不是 500（客户端问题不该报成服务端错误） — HTTP 403
PASS 格式就不对的令牌换不到会话，且是 400 — HTTP 400
PASS 请求体里的 approved/user_id/principal_id/audience/capabilities 换不到任何授权 — …
PASS 控制操作清单由能力表推导，且与显式分类清单逐条一致 — 8 个控制操作
```

**这一条不是"检查过的"，是**构造上做不到**。** 三层，每层都是抛错而不是告警：

1. **注册期。** `ControlRouteTable.register()` 在路由要求的能力属于
   `CAPABILITIES_BY_AUDIENCE['mcp-adapter']` 时**直接抛错**，控制平面起不来。
   判据读的是 IPC 层运行时鉴权用的**同一张表**（`hasCapability('mcp-adapter', …)`），
   因此不存在「装配时以为模型够不着、运行时却够得着」这种情况。
2. **装配期。** 控制操作清单由能力表推导；一个控制操作若没被显式分类为
   变更类或只读类，`createControlPlane()` 拒绝装配。反向也查：清单里留下一个
   已不存在（或其能力已授予模型侧）的操作同样拒绝 —— 否则这份清单已经与能力表
   脱节，而它下一次会被照着抄。
3. **运行期。** 控制路由要求会话 cookie，而 cookie 只能由启动令牌兑换得到，
   启动令牌只能由 daemon 在操作者的终端里签发（`mintBootstrap()`）。
   适配器那侧的凭证与它**在结构上没有任何关系**，因此"拿适配器凭证当 cookie"
   这类尝试连一个可比较的字段都找不到 —— 上面四条素材全部 401。

**能力决定「能不能发起」，批准决定「能不能落地」。** 见 §5 的偏离项：
`change_apply` 要求 `propose` 而不是 `apply`，因为契约明确规定
「MCP 适配器凭据不得包含 `apply`」，而工具契约要求模型单独调用应用工具只得到
`APPROVAL_REQUIRED`。这里放宽的只是"能发起请求"，没有放宽"能产生授权"。

**分类错误的方向是单向的，所以宁可让它必须被写下来。** 把一个变更类操作误判为
只读，它就**不需要一次性 nonce** 了，而这条失效在功能上完全看不出来
（按钮照常工作）。这就是为什么 `MUTATING_OPERATIONS` / `READ_ONLY_OPERATIONS`
必须是显式清单，且两个方向都要断言。

### 验收标准 3 · 工具结果不含控制台登录令牌或带授权效果的 URL

```
PASS 出站筛查命中：启动令牌 — 规则 control-plane-token，档位 certain
PASS 出站筛查命中：会话 cookie 值 — 规则 control-plane-token，档位 certain
PASS 出站筛查命中：CSRF 令牌 — 规则 control-plane-token，档位 certain
PASS 出站筛查命中：一次性 nonce — 规则 control-plane-token，档位 certain
PASS 规则清单里确实有 control-plane-token（规则集与代码同源读出） — 15 条规则
NOTE 被测试的文本 — "README 片段：\n启动地址 http://127.0.0.1:51234/#t=lwb_boot_fWu5UlpjLKze4Gq9YS6MWdJt50ZfJVGgkkEBsn5zEQI\n其余内容\n"
PASS 读取面：启动 URL 里的令牌被脱敏，其余内容仍可读 — "README 片段：\n启动地址 http://127.0.0.1:51234/#t=[REDACTED:control-plane-token]\n其余内容\n"
PASS 脱敏过的读取拿不到可编辑票据（令牌不会经由票据回到写入路径） — mintEditTicket() 返回 null
PASS 搜索片段面：整块阻断（拿不到"脱敏放行"这条出路） — SECRET_DETECTED
PASS Git 差异面：整块阻断（拿不到"脱敏放行"这条出路） — SECRET_DETECTED
PASS 启动 URL 把令牌放在片段里（片段不会被浏览器发往服务器，不进请求行、不进日志、不进 Referer） — …
PASS 控制台只从片段里、且只按 lwb_boot_ 形状读令牌 — …
PASS 控制台用真令牌走完整条兑换链路：拿到会话（证明上面的顺序断言不是空跑） — session_id=s2-11bd1a36c760
PASS 控制台先抹片段、再兑换（顺序反了的话，失败分支会把失效令牌留在地址栏里） — strip → fetch
PASS 控制台与服务端算出的请求体摘要逐字节相同（含中文键与任意键序） — 4 个样本，不一致 0 个
PASS 摘要排除 nonce 字段（否则 nonce 无法绑定"不含它自己的那份内容"） — 换一个 nonce，摘要不变
PASS 控制台客户端拒绝非回环 origin — 构造时抛错
```

**这条标准里"控制台登录令牌"与 LWB-011 各条规则保护的东西性质不同。**
LWB-011 的各条规则保护的是**用户的**秘密（`.env` 里的密钥、私钥、云厂商令牌）；
这一条保护的是**本程序自己的授权凭据**。泄露它不等于泄露某份文件，
而是等于把「批准」这件事本身交出去 —— 持有者可以批准自己的写入。
因此它是一条独立的 `certain` 档规则（`control-plane-token`）：
形状即凭证，不存在"可能是占位符"的情形，也就没有脱敏放行的余地。

**规则形状与签发端共用一份定义，因此不可能漂移。**
`packages/contracts/src/control.ts` 同时被 daemon（生成令牌）与 `@lwb/egress`
（筛查令牌）导入；`newControlToken()` 还会**自校验**生成的令牌体长度与
`CONTROL_TOKEN_BODY_LENGTH` 是否一致，不一致就抛错 —— 因为长度漂移意味着
筛查规则**静默地不再匹配**，而那种失效不会有任何报错。

**"带授权效果的 URL"是同一个形状问题。** `http://127.0.0.1:PORT/#t=lwb_boot_…`
之所以被拦，不是因为它是一条 URL，而是因为**它含那个形状**。这比逐条枚举
"带授权效果的接口路径"要稳：将来新增任何带令牌的路径（重设、恢复、配对）
都自动被覆盖，因为覆盖它的是形状而不是路径清单。

**令牌放在片段（`#`）里，不是查询串。** 片段不会被浏览器发往服务器：
它不参与请求行、不进访问日志、不会作为 `Referer` 的一部分泄露。
而"先抹片段、再兑换"的顺序也是刻意的 —— 常见的写法是先兑换、成功了再抹，
那条路径下如果兑换失败（daemon 重启过、令牌已过期），**失败分支里没人抹片段**，
于是一张失效但看起来有效的令牌留在地址栏里，用户会去刷新、去重试、
把它复制粘贴到别处。

---

## 2. 与「不检查的实现」的并排对照

这是本次采集里最有说服力的一段，因此单独列出来。上面的 12 条恶意请求
**同时**发给两个服务：真的控制平面，以及一个在同一个绑定地址上、
不查 Host/Origin/CSRF/nonce 的裸 `http` 服务。

```
PASS 对照：同一个监听地址上、不查 Host/Origin/CSRF/nonce 的实现，这些请求全部会成功 — 12/12 条被接受
PASS 对照：同一份内容、来源正确的请求会成功（因此上面的拒绝不是"谁来都拒"） — HTTP 200
```

对照服务接受明细：12 条全部 `200`（跨站 fetch、DNS rebinding、`Origin: null`、
缺 Origin、表单类型 ×2、同站不同端口、`Sec-Fetch-Site: cross-site`、
缺 CSRF、缺 nonce、绝对形式目标、查询串）。

**为什么必须有这个对照。** 没有它，「请求被拒了」证明不了是**这些检查**在起作用 ——
它同样可能只是"这个操作本来就不可用"或"路由没注册"。对照把两种解释分开：
同一个请求在未检查的实现上成功、在被检查的实现上失败，
所以差别只能来自检查本身。

第二个对照（同源的正确请求返回 200）挡的是另一个方向的误读：
如果所有请求都被拒，上一条又可以解释成"服务端坏了"。

---

## 3. 会话与一次性 nonce 的实测口径

| 项 | 取值 | 出处 |
|---|---|---|
| 启动令牌有效期 | 5 分钟 | `constants.ts` `BOOTSTRAP_TTL_MS` |
| 会话绝对上限默认值 | 2 小时；受保护 JSON 中可配置为 1 分钟至 30 天或 `null`（无限） | `session.absolute_timeout_ms` |
| 会话空闲上限默认值 | 关闭；受保护 JSON 中可配置，`0` 表示关闭 | `session.idle_timeout_ms` |
| 一次性 nonce 有效期 | 10 分钟（与方案的本地批准有效期一致） | `NONCE_TTL_MS` |
| 并发会话上限 | 不设固定数量；过期会话在后续请求时清理 | `ControlSessionStore` |
| 请求体上限 | 64 KiB | `MAX_BODY_BYTES` |

新的进程启动时会作废先前进程遗留的待兑换令牌。运行期间，已登录控制台可签发
额外的浏览器接入链接；每条链接 5 分钟有效、只可兑换一次，并且可以并行存在。
页面刷新会通过现有 HttpOnly cookie 恢复会话；打开中的页面每 5 分钟检查一次会话，
空闲期限可关闭或配置，绝对有效期默认 2 小时，也可在控制台配置页调整。
同一 JSON 文件中的 `workspaces` 保存根路径、模式、状态与 `authorized_tools`；工具授权以 JSON 为准，SQLite 保留工作区身份/历史记录，并在启动时同步授权镜像。

**持续活动续不了绝对上限。** 配置为有限期限时，会话在该期限后失效；请求和定时检查不会续期。设为 `null` 时不施加绝对期限。

**nonce 现在证明的是"一次性与内容绑定"，不证明"操作者确实看过这份内容"。**
后者要求 nonce 由**渲染审核页的那次读取**一并签发，那是 LWB-022（本地审批）
的职责。这条边界写在 `session.ts` 的文件头里，是为了避免将来有人把现状
读成"批准链路已经完备"。

---

## 4. 采集过程中发现并修复的真实缺陷

六条，都是**实现已经写完、类型检查通过、而且"看起来对"**的。
列在这里，因为它们是本任务最有价值的部分。

### 4.1 `parseAuthority` 声称只认 IPv4 字面量，实际从不检查

文件头与函数注释都写着「刻意只接受 IPv4 字面量 + 端口」，代码里却只有
`if (host.length === 0) return null;` —— **`localhost:51234` 会被解析成一个
合法的主机名**。`checkHost` 随后因为"不等于 `127.0.0.1`"把它拒掉，
所以最终行为是对的，但**拒的理由是错的**，而这个函数的名字与注释
让下一个使用它的人以为拿到的一定是字面量。

更值得记的是它的失效方式：如果将来有人复用 `parseAuthority` 做别的判断
（比如"这个来源是不是本机"），他会得到一个"看起来能用但语义已经跑偏"的接口。

修法是让它真的只认**规范形式**的点分四段：必须是四段十进制，
且**不允许前导零**。后者不是洁癖 —— `010.1.1.1` 在部分解析器里按八进制读
（= `8.1.1.1`），在另一些里按十进制读，这是 SSRF 绕过的经典手法。
与其规定"按哪种进制解释"（那是一条要长期维护的规则），不如不接受这种形态。

### 4.2 客户端问题被报成服务端内部错误（500）

`POST /api/session` 的处理函数在令牌格式不对、或令牌无效时抛的是普通 `Error`，
而服务器的错误收敛把非 `BridgeError` 一律折成 `INTERNAL_ERROR` / 500。
于是**"你的地址栏里少了一段"在控制台看来是"本地服务内部错误"** ——
操作者会去查服务端的 bug。已改为 `INVALID_ARGUMENT`（400）与
`NOT_AUTHORIZED`（403），并在证据与测试里把状态码**钉到具体值**
而不是 `>= 400`，否则"又变回 500"这件事不会被发现。

### 4.3 `assert.equal` 的第三个参数是立即求值的

```ts
// 写法（错）：body 在断言之前就被读掉了
assert.equal(response.status, 200, `失败：${await response.text()}`);
const payload = await response.json();   // → "Body is unusable"
```

消息参数**总是**先于断言求值，所以成功路径上 body 已经被消费。
恶劣之处在于它**只在成功时炸**：失败路径上断言先抛，看起来一切正常；
一旦 fixture 修好、请求真的成功了，测试才开始报一个像是被测代码缺陷的错误。
本次九条用例同时变红，根因就是这一行。改成先 `await text()` 再断言。

### 4.4 原始套接字必须自己写 `Content-Length`

证据脚本的 `rawRequest` 最初只拼请求行 + 头 + `\r\n\r\n` + 正文。
少了 `Content-Length`，HTTP 解析器认为这个请求**没有正文**，
后面的字节被当成下一个请求的开头 —— 服务端读到一个空体。
表现是「缺 nonce」，而不是「解析失败」：**正文看起来发出去了，实际从没到达**。
这一条同时污染了对照服务的结论（12 条全部 400，而不是 200）。
一个手搓报文的测试装置，必须自己负责报文的完整性。

### 4.5 客户端把 `Origin` 交给浏览器去补，于是它在浏览器之外不可测

`ControlClient` 原先不写 `Origin`，依赖浏览器自动添加。这在浏览器里是对的，
但它是一条**只写在运行环境里、不在代码里**的依赖：任何一层把 `Origin` 吃掉
（polyfill、Service Worker、代理壳），控制台就整个不能用，而报错只会说
"请求来源不被接受"。同时它让这半条链路在 node 里无法测试 ——
采集时才发现**裸 `fetch` 根本不发 `Origin`**（实测 `POST` 与 `GET` 的
`req.headers.origin` 都是 `undefined`）。

现在显式写进报文：在浏览器里 `Origin` 属于 fetch 的**禁止头**，
设置会被忽略、浏览器仍写入自己的值，因此那一行是空操作；
在非浏览器环境里它是那个必需的补全。**两边都正确**，
且这条依赖从此写在代码里。

### 4.6 nonce 摘要少算一个字段，会让每一次变更都被拒

服务端绑定的摘要覆盖「即将发送的请求体去掉 `nonce`」，而请求体里**包含 `subject`**。
一个自然的写法是「先算 `body` 的摘要，申请 nonce，再把 `subject` 加进请求体」——
得到的是一张**永远不会匹配**的 nonce，而失败信息只说"与本次请求的内容不匹配"，
看不出是哪里多算少算了。

修法不是加注释，是在客户端加一个**不可能写错**的入口：
`ControlClient.authorizeMutation(operation, subject, body)` 由它自己算摘要、
自己申请 nonce，返回最终应当发送的请求体。低层的 `requestNonce` 保留
（它是传输调用），但它的文档写明了失败模式。

---

## 5. 偏离项与设计取舍

### 5.1 交付物路径：`apps/console/auth/` → `apps/console/src/auth/`

任务书写 `apps/console/auth/`，实际放在 `apps/console/src/auth/`。
理由与 LWB-008 的偏离项相同（`docs/PROGRESS.md` 偏离项 7）：
仓库的静态检查按 `apps/console/src/` 前缀识别业务包
（`scripts/check-fsguard-imports.mjs` 的 `BUSINESS_PREFIXES`），
放在 `src/` 之外会让这层代码**落在两个清单之外** ——
既不被允许、也不被检查，而检查器照常打印"未发现绕过"（同偏离项 9 的静默盲区）。

### 5.2 `change_apply` 要求 `propose`，不要求 `apply`

沿用 LWB-011 的偏离项 14，此处不重复。

### 5.3 `Sec-Fetch-Site` 缺失时放行，而 `Origin` 缺失时拒绝

两者看似不一致，实则依据相同：`Origin` 是**所有 HTTP 客户端**都能发的头，
因此"变更类请求必须带 Origin"是一条可以要求、也能够被满足的规则，
它把攻击面收窄到"浏览器里的页面"；而 `Sec-Fetch-Site` 是浏览器专有头，
拿它当硬边界会让所有非 Chromium 浏览器无法使用控制台。
它只是纵深防御的一层 —— 真正的边界是 **Host + Origin + CSRF** 三者，
上面 12 条拒绝里没有任何一条**单独**依赖 `Sec-Fetch-Site`。

### 5.4 控制台界面不在本任务范围内

按方案 §10.1，六个页面（连接与状态、工作区、待批准、操作详情、冲突/恢复、
历史与审计）属于 **LWB-035**。本任务只交付界面必须依赖的认证层，
并且刻意做成**框架无关的纯 TypeScript** —— 于是它能在 node 里被直接测试，
而不必先跑起一个浏览器。仓库的 tsconfig 只有 `lib: ["ES2023"]`、
**没有 DOM lib**，这不是疏漏，是有意的：它让这一层不可能依赖浏览器全局，
从而"我先在浏览器里点一遍"不会被误当成验证。

---

## 6. 未执行项（不得记为通过）

```
NOT_RUN 真实浏览器里的控制台端到端验收 — 控制台界面属 LWB-035；本任务不带 DOM、不开浏览器
NOT_RUN 真实 ChatGPT Web 端到端验收 — 需要真实账号与 Secure MCP Tunnel 凭据；LWB-002 仍为 BLOCKED
NOT_RUN 从局域网另一台机器发起攻击 — 需要在第二台机器上执行，本机无法自证
NOT_RUN DNS rebinding 的真实浏览器复现（自建 DNS + 域名） — 需要控制一个域名与 DNS 服务；本任务只验证服务端侧的 Host 判定
```

关于第一项：本任务**不能**用「在浏览器里点一遍控制台」作为验收 ——
控制台界面还不存在，而且即使存在，那也只是 LWB-035 的验收。
本任务能被自证的部分是：服务端拒绝逻辑（原始报文级）、
控制台认证逻辑（node 里直接调用）、以及两者之间的摘要约定一致。

关于第四项：真实 DNS rebinding 需要控制一个域名并让它解析到 `127.0.0.1`。
本任务验证的是**服务端侧的判定**——即"当 `Host` 不是绑定的那个字面量时一律拒绝"，
这一点由原始报文逐条证明。从"服务端会拒绝"到"攻击不成"之间，
剩下的那一步（攻击者能否让 `Host` 变成别的值）在攻击者一侧，不在本层。

---

## 7. 变更文件

| 文件 | 行数 | 内容 |
|---|---|---|
| `packages/contracts/src/control.ts` | 116 | 控制平面凭证形状的**唯一定义**（签发端与筛查端共用）；cookie 名与 CSRF 头名 |
| `packages/contracts/src/index.ts` | +1 | 导出上一行 |
| `packages/egress/src/secrets.ts` | +9 | 新增第 15 条规则 `control-plane-token`（certain 档） |
| `apps/daemon/src/control/tokens.ts` | 69 | 令牌生成（含对 `CONTROL_TOKEN_BODY_LENGTH` 的自校验）、摘要、定长比较 |
| `apps/daemon/src/control/constants.ts` | 59 | 绑定地址（常量，不可配置）、各 TTL、体积上限 |
| `apps/daemon/src/control/origin.ts` | 293 | `Host` / `Origin` / `Sec-Fetch-Site` / 请求目标 / content-type 判定；规范 IPv4 |
| `apps/daemon/src/control/session.ts` | 423 | 启动令牌、会话、CSRF、一次性 nonce；cookie 属性 |
| `apps/daemon/src/control/routes.ts` | 201 | 路由表与**注册期**能力断言；操作 → 路由映射 |
| `apps/daemon/src/control/server.ts` | 490 | HTTP 服务与 0–7 号闸门顺序；响应头；错误收敛 |
| `apps/daemon/src/control/control-plane.ts` | 227 | 装配：路由由能力表推导；变更/只读分类的双向断言 |
| `apps/daemon/src/control/index.ts` | 108 | 导出与"本目录不做什么" |
| `apps/console/src/auth/bootstrap.ts` | 191 | 片段读令牌 → 抹片段 → 兑换；回环来源判定 |
| `apps/console/src/auth/client.ts` | 253 | 控制 API 客户端；CSRF 头；`authorizeMutation`；摘要 |
| `apps/console/src/auth/constants.ts` | 9 | 转出 contracts 的常量（不重新定义） |
| `apps/console/src/auth/index.ts` | 46 | 导出与"这不是控制台界面"的说明 |
| `apps/console/package.json` | — | 新工作区包 `@lwb/console`（`dev` 脚本报错并说明属 LWB-035） |
| `tests/unit/control-plane.test.ts` | 1535 | 74 项 |
| `scripts/evidence/lwb-012.ts` | 905 | 本证据的采集脚本 |
| `docs/evidence/lwb-011/summary.md` | +17 | 秘密规则清单 14 → 15 条，加入 `control-plane-token` 及其性质说明 |

`apps/console/src/` 已在 `scripts/check-fsguard-imports.mjs` 的 `BUSINESS_PREFIXES` 中
（LWB-011 时加入），本次未改检查器配置；文件数 66 → 79 由新增的 `.ts` 文件带来。

---

## 8. 回归

```
$ npx tsc --noEmit                             → 退出码 0
$ node scripts/check-fsguard-imports.mjs       → 79 个文件，未发现绕过
$ node scripts/run-tests.mjs                   → tests 567 / pass 567 / fail 0
$ node --test --import tsx tests/unit/control-plane.test.ts → tests 74 / pass 74 / fail 0
$ node --import tsx scripts/evidence/lwb-011.ts → 38 PASS / 0 FAIL / 1 NOT_RUN，退出码 0
$ node --import tsx scripts/evidence/lwb-012.ts → 50 PASS / 0 FAIL / 4 NOT_RUN，退出码 0
```

LWB-011 的证据脚本在本次改动后**重新采集过**（新增规则会让它打印 15 条），
因此上面那一行是本次的运行结果，不是上一轮的引用。
