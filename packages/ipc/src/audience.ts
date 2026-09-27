/**
 * 连接身份与能力（LWB-008 步骤 2）。
 *
 * ## 「audience」为什么必须存在
 *
 * daemon 面向两类本地调用者：`mcp-adapter`（模型意图的入口）与 `console`（人的入口）。
 * 两者能力完全不同 —— 控制台能注册工作区、批准修改、改变策略；
 * 适配器**永远不能**做这些（I02：「工作区根、连接权限和安全规则不能由模型扩大」）。
 *
 * 如果两者共用一把凭证，那么拿到适配器凭证就等于拿到控制台能力。
 * 因此凭证按 audience **派生**：`key = HMAC(ipc_secret, audience)`。
 * 适配器的凭证在控制台这条 audience 上算不出正确的证明，
 * 这不是一条 `if` 判断，而是**密码学上的不可用**。
 *
 * 反向同样重要：控制台凭证**不能**降级当适配器用（虽然看起来无害）。
 * 允许降级会带来一条隐蔽的路径 —— 控制台凭证泄露后可以冒充适配器发出请求，
 * 而这些请求在审计里会记成「来自适配器」。分离是双向的。
 */

export const AUDIENCES = ['mcp-adapter', 'console'] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

/** 能力是**闭集**：没有「临时加一个」的路径。 */
export const CAPABILITIES = [
  /** 只读工具面：status/list/read/search/git */
  'tools.read',
  /** 提交修改集（不写文件） */
  'tools.propose',
  /** 请求执行修改集（仍需本地批准） */
  'tools.apply',
  /** 读取审计事件 */
  'audit.read',
  /** 注册/移除/暂停工作区 */
  'workspaces.manage',
  /**
   * 停用/启用**连接**（LWB-018 步骤 3）。
   *
   * 与 `workspaces.manage` 分开：连接不是目录。这条能力表达的是
   * 「这条凭证现在还不许调用工具面」，而撤权要靠它才能被操作者拉动 ——
   * 在此之前 `connections.enabled` 只有测试代码写过。
   */
  'connections.manage',
  /**
   * 暂停/恢复**整个本地服务**（LWB-034 的紧急停用）。
   *
   * 与 `connections.manage` 分开，而且这次分开的理由比上一次更硬：
   * 那个停的是一条凭证，这个停的是**这台机器上全部写入**。把它并进
   * `workspaces.manage` 会让「按下紧急停用」在能力表里读起来像一次
   * 工作区动作，而 `connections.manage` 停不了正在跑的那次写入 ——
   * 停不了写进程的「暂停」正是这一格要防的那种假动作。
   */
  'service.control',
  /** 批准修改集 */
  'approvals.decide',
  /**
   * 读**本机上的**修改集：状态、回执、逐文件差异（LWB-036）。
   *
   * 为什么不复用 `tools.read`：那张表上 `tools.read` 是**授予模型的**，
   * 而 `ControlRouteTable.register` 会拒绝任何「要求一个模型侧也具备的能力」
   * 的控制路由（那等于把这条接口开放给模型）。控制台要读修改集，
   * 就必须有一条**只属于控制台**的能力来表达这件事 —— 而不是把一条
   * 已有的、模型也有的能力借过来用。
   *
   * 与 `tools.read` 的**范围**也不同，而这正是它必须是独立一条的理由：
   * `tools.read` 的读法按 `owner_connection_id` 收窄（模型只看得到
   * 自己提议的那些），控制台看的是**这台机器上的**全部修改集 ——
   * 包括别的连接提议的。两件事的判据不同，共用一个名字会让「谁在什么
   * 范围里能读」这件事在能力表上读不出来。
   */
  'changes.read',
  /** 改变策略与限额 */
  'policy.manage',
  /** 导出诊断包 */
  'diagnostics.export',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * audience → 能力的映射。
 *
 * **这是唯一的授权来源。** 工具参数、请求体、隧道身份都不参与。
 * 每次请求都要重新查这张表，而不是在连接建立时缓存一份 ——
 * 缓存会让「收紧策略」在旧连接上延迟生效。
 */
export const CAPABILITIES_BY_AUDIENCE: Readonly<Record<Audience, readonly Capability[]>> = {
  'mcp-adapter': ['tools.read', 'tools.propose', 'tools.apply'],
  console: [
    'tools.read',
    'audit.read',
    'workspaces.manage',
    'connections.manage',
    'service.control',
    'approvals.decide',
    'changes.read',
    'policy.manage',
    'diagnostics.export',
  ],
};

/** 每个 audience 的连接凭证。**必须各不相同**。 */
export type AudienceSecrets = Readonly<Record<Audience, string>>;

/**
 * 校验各 audience 的凭证互不相同。daemon 启动时调用，不通过就拒绝启动。
 *
 * 这条检查存在的理由：如果两类 audience 共用一把凭证，那么
 * 「按 audience 派生密钥」退化成一个公开的变换 —— 拿到适配器凭证的人
 * 可以自行算出控制台凭证的证明。配置合并、环境变量覆写、
 * 复制粘贴模板都很容易造成这种结果，而后果是**静默的**：
 * 一切照常工作，只是分离没了。所以宁可拒绝启动。
 */
export function assertAudienceSecretsDistinct(secrets: AudienceSecrets): void {
  const seen = new Map<string, Audience>();
  for (const audience of AUDIENCES) {
    const secret = secrets[audience];
    if (typeof secret !== 'string' || secret.length < 16) {
      throw new Error(`audience ${audience} 的连接凭证缺失或过短（至少 16 字符）。`);
    }
    const previous = seen.get(secret);
    if (previous !== undefined) {
      throw new Error(
        `audience ${previous} 与 ${audience} 使用了相同的连接凭证。` +
          '共用凭证会让「按 audience 派生密钥」失去意义：一方可以算出另一方的证明。',
      );
    }
    seen.set(secret, audience);
  }
}

export function capabilitiesOf(audience: Audience): readonly Capability[] {
  return CAPABILITIES_BY_AUDIENCE[audience];
}

export function hasCapability(audience: Audience, capability: Capability): boolean {
  return CAPABILITIES_BY_AUDIENCE[audience].includes(capability);
}

/**
 * 模型侧**永远**不具备的能力，单列出来以便测试逐条钉住。
 *
 * 写成独立常量而不是从上面的表推导，是为了让「哪些能力绝不能给模型」
 * 成为一个可以被评审、被测试直接引用的清单 —— 推导出来的东西
 * 会在有人修改上表时**静默**变化。
 */
export const NEVER_GRANTED_TO_MODEL: readonly Capability[] = [
  'workspaces.manage',
  'connections.manage',
  'service.control',
  'approvals.decide',
  'changes.read',
  'policy.manage',
  'audit.read',
  'diagnostics.export',
];
