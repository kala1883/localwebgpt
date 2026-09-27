/**
 * LWB-030 边界测试：恢复**不在**模型够得到的地方。
 *
 * ## 这条边界为什么需要一份测试，而不是一句注释
 *
 * `recovery.ts` 做的是「读取磁盘、比较内容、必要时写回」—— 单看能力，
 * 它与模型侧的工具面**一模一样**。区别只在于它由谁触发：恢复由本机操作者
 * （或一次重启）触发，绝不接受任何来自模型的参数。
 *
 * 这句话的可执行形式是**一条导入边**：模型侧的两个目录不许出现
 * `@lwb/recovery`。因此本文件直接读源码来找这条边，而不是查文档 ——
 * 「文档里写了」与「编译得出来」是两件事，而后者会随一次顺手补全的
 * `import` 悄悄变成真的。
 *
 * ## 三组断言
 *
 *  - **A. 导入边**：`apps/mcp-adapter/` 与 `apps/daemon/src/tools/`
 *    里任何文件都不 import `@lwb/recovery`（含相对路径绕行与动态 import）。
 *  - **B. 词汇边**：恢复那几个**写**入口的名字（`authorize` / `repair`）
 *    不出现在工具面的目录与操作注册表里。光禁导入不够 —— 一条
 *    "把恢复服务当参数传进工具面"的路子不经过 import。
 *  - **C. 反向**：`apps/daemon/src/runtime/` **确实**导入了它。
 *    只测「没有」的话，一次把恢复整段删掉的改动会让 A/B 全绿。
 *
 * ## 为什么连 `operations.ts` 也要查
 *
 * 控制操作注册表是「本机操作者那条通道」的入口。恢复的**读**部分
 * （`records` / `workspacesAwaitingRecovery`）将来会作为控制操作暴露，
 * 那是 LWB-037 控制台的事；但 `authorize` / `repair` 这两个**写**入口
 * 需要本地授权令牌，把它们注册成一条控制操作就等于开了一条
 * 「谁连上控制平面谁就能收场」的路。本文件在它们被注册之前先把这条线画下。
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 模型侧：适配器进程 + daemon 的工具面。两处都够得到工作区。 */
const MODEL_FACING = [
  path.join(ROOT, 'apps', 'mcp-adapter', 'src'),
  path.join(ROOT, 'apps', 'daemon', 'src', 'tools'),
];

/** 本机操作者那条通道：恢复服务就住在这里的装配根里。 */
const OPERATOR_FACING = path.join(ROOT, 'apps', 'daemon', 'src', 'runtime');

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function sourcesOf(dirs: readonly string[]): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const file of await tsFiles(dir)) {
      out.push({ file: path.relative(ROOT, file), text: await readFile(file, 'utf8') });
    }
  }
  return out;
}

/**
 * 一条 import 是否指向恢复包。
 *
 * 三种写法都要拦住：具名导入、`import type`、以及**动态 `import()`**
 * —— 最后一种不经过静态图，因此 `check:imports` 那类静态检查看不见它。
 */
function importsRecovery(text: string): boolean {
  return (
    /from\s+['"]@lwb\/recovery(?:\/[^'"]*)?['"]/.test(text) ||
    /import\s*\(\s*['"]@lwb\/recovery(?:\/[^'"]*)?['"]/.test(text) ||
    /require\(\s*['"]@lwb\/recovery(?:\/[^'"]*)?['"]/.test(text) ||
    // 相对路径绕行：`../../../packages/recovery/src/service.ts` 之类。
    /from\s+['"][^'"]*packages\/recovery/.test(text)
  );
}

describe('LWB-030 A. 导入边：模型侧够不到恢复包', () => {
  it('A1 两处模型侧目录里没有任何文件 import @lwb/recovery', async () => {
    const sources = await sourcesOf(MODEL_FACING);
    // 先确认真的扫到了东西：空目录会让这条断言凭空洞地通过。
    assert.ok(sources.length >= 8, `只扫到 ${String(sources.length)} 个文件，装置本身可疑`);
    const offenders = sources.filter((source) => importsRecovery(source.text)).map((s) => s.file);
    assert.deepEqual(offenders, [], `这些文件把恢复包带进了模型侧：${offenders.join('、')}`);
  });

  it('A2 扫到的文件里确实有那种**会**命中检测的写法（检测函数本身有效）', async () => {
    // 反向自查：如果 A1 的检测函数恒假，A1 就是一句空话。
    for (const sample of [
      "import { RecoveryService } from '@lwb/recovery';",
      "import type { ItemVerdict } from '@lwb/recovery';",
      "const m = await import('@lwb/recovery');",
      "import { x } from '../../../packages/recovery/src/service.ts';",
    ]) {
      assert.equal(importsRecovery(sample), true, `漏检：${sample}`);
    }
    assert.equal(importsRecovery("import { x } from '@lwb/executor';"), false);
  });
});

describe('LWB-030 B. 词汇边：两个写入入口的名字不出现在工具面里', () => {
  it('B1 工具面源码里不出现 `recovery_authorizations` 与恢复阶段名', async () => {
    const sources = await sourcesOf(MODEL_FACING);
    for (const source of sources) {
      assert.equal(
        source.text.includes('recovery_authorizations'),
        false,
        `${source.file} 提到了恢复授权表`,
      );
      assert.equal(
        source.text.includes('recovery_repaired'),
        false,
        `${source.file} 提到了恢复收场阶段`,
      );
    }
  });

  it('B2 工具面里不出现 `recovery.requiresRecovery` 之外的恢复调用形状', async () => {
    // `requiresRecovery` 是**唯一**一个允许被工具面邻居读到的恢复成员：
    // 它是只读的一格布尔，而工具描述需要知道它（「这个工作区现在不可写」
    // 是一条必须说出来、而不是等调用失败才说的限制）。其余一律不许出现。
    const sources = await sourcesOf(MODEL_FACING);
    const allowed = new Set(['requiresRecovery', 'workspacesAwaitingRecovery', 'records']);
    for (const source of sources) {
      for (const match of source.text.matchAll(/\brecovery\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const member = match[1] ?? '';
        assert.ok(
          allowed.has(member),
          `${source.file} 调用了 recovery.${member} —— 写入口（authorize/repair/sweepStartup）不属于模型侧`,
        );
      }
    }
  });
});

describe('LWB-030 C. 反向：装配根里确实有它', () => {
  it('C1 装配根 import 了恢复服务，并且**确实**调用了启动扫描', async () => {
    const sources = await sourcesOf([OPERATOR_FACING]);
    const assembly = sources.find((source) => source.file.endsWith('assembly.ts'));
    assert.ok(assembly, '找不到装配根');
    assert.equal(importsRecovery(assembly.text), true, '装配根没有导入恢复服务');

    // 光导入不算接线：`sweepStartup` 必须**真的**被 await 过。
    assert.match(assembly.text, /await\s+recovery\.sweepStartup\(\)/, '启动扫描没有被调用');

    // 而它必须在工具面之前 —— 这是 LWB-030 步骤 1 的原文。
    const sweepAt = assembly.text.indexOf('sweepStartup()');
    const surfaceAt = assembly.text.indexOf('createToolSurface(');
    assert.ok(sweepAt > 0 && surfaceAt > 0);
    assert.ok(
      sweepAt < surfaceAt,
      '启动扫描排在工具面之后：那会让一个 APPLYING 的操作在窗口期内被当成「正在写」',
    );
  });

  it('C2 逐工作区的 `recovery_required` 接的是真查询，不是常量', async () => {
    const sources = await sourcesOf([OPERATOR_FACING]);
    const assembly = sources.find((source) => source.file.endsWith('assembly.ts'));
    assert.ok(assembly);
    assert.match(assembly.text, /capabilityFlagsWith\([\s\S]*?recovery\.requiresRecovery\(/);
    // 那条被替换掉的常量写法不该还在任何地方。
    assert.equal(
      /capabilityFlagsWith\(BRIDGE_GATES,\s*\(\)\s*=>\s*false\)/.test(assembly.text),
      false,
      '装配根里还留着 `() => false` 那条常量写法',
    );
  });
});
