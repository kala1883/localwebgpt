/**
 * LWB-033 · 门禁取值的**穷尽**表，与「直写开关不能被配置打开」。
 *
 * ## 这一格要钉的是哪句话
 *
 * LWB-033 的验收标准 3：**「G4 未通过时 direct_write 永远不对真实目录启用。」**
 *
 * 「永远」这个词有两个方向，它们必须分开验，因为它们的失败方式完全不同：
 *
 *  1. **对每一组门禁取值都成立** —— 这是一个**代数**事实，可以穷尽：
 *     `PlatformGates` 有四个布尔，只有 16 种取值。只要把 16 格全跑一遍、
 *     逐格断言 `direct_write_enabled === (四项全真)`，就没有「某一格里漏了」
 *     的余地。只测一两格的话，「直写永远为真」和「直写永远为假」这两种
 *     实现都能过。
 *  2. **没有任何运行时入口能把它打开** —— 这是一个**结构**事实，穷尽不了，
 *     只能扫源码：`BRIDGE_GATES` 必须是一个字面常量，`gates.ts` 里不能出现
 *     环境变量、配置文件、命令行参数的读取。没有这一条，第 1 条只证明了
 *     「算得对」，没证明「输入不可篡改」—— 而 `docs/adr/003` 把「不自行放宽
 *     权限」列成了最需要防住的那一类失败。
 *
 * ## 为什么这一格不是「把 §4 那 8 格抄一遍」
 *
 * `scripts/evidence/lwb-025.ts` 已经有一张 8 格表，但它钉的是**原生护栏**
 * 那一个与项（G4 那一维固定为真）。LWB-033 给 `capabilityFlagsFrom` 加了
 * 第四个与项，于是「穷尽」这个词的**分母**变了：8 格不再是全部。
 * 本文件与它并存，不是替代 —— 那一份是已交付任务的证据，改了它，
 * 它那份摘要是记着 65 PASS 的。
 *
 * ## 反向探针
 *
 * 一个「`direct_write_enabled` 恒为 false」的实现会让第 1 条**全绿**。
 * 因此这里必须同时证明那个开关**真的能被算成真** —— 否则这一格验的
 * 是一条空话（本仓库处理这类断言的既有做法，见 LWB-031 的 §7.8c/§7.8d）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRIDGE_CAPABILITY_FLAGS, BRIDGE_GATES, capabilityFlagsFrom, limitationsOf } from '../../apps/daemon/src/gates.ts';
import type { PlatformGates } from '../../apps/daemon/src/gates.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** 四维的**全部** 16 种取值。写成显式的四个数组，好让每一维的名字留在用例里。 */
const ALL_COMBINATIONS: readonly PlatformGates[] = [false, true].flatMap((g0) =>
  [false, true].flatMap((native) =>
    [false, true].flatMap((section3) =>
      [false, true].map((g4) => ({
        g0_platform_verified: g0,
        native_guard_verified: native,
        compatibility_section3_passed: section3,
        g4_concurrency_fault_passed: g4,
      })),
    ),
  ),
);

/** 一格门禁取值印成一行，失败时能一眼看出是**哪一格**。 */
const shape = (g: PlatformGates): string =>
  `g0=${g.g0_platform_verified ? 1 : 0} native=${g.native_guard_verified ? 1 : 0} ` +
  `§3=${g.compatibility_section3_passed ? 1 : 0} g4=${g.g4_concurrency_fault_passed ? 1 : 0}`;

describe('LWB-033 · 门禁取值穷尽表', () => {
  it('四个布尔一共 16 格，本文件一格不落', () => {
    assert.equal(ALL_COMBINATIONS.length, 16);
    // 去重：四个 flatMap 写错一层（比如漏掉一维）时，长度可能仍是 16
    // 但内容会重复 —— 那样「穷尽」就是假的。
    assert.equal(new Set(ALL_COMBINATIONS.map(shape)).size, 16);
  });

  it('16 格里，直写开关为真**当且仅当**四项全真', () => {
    const table: string[] = [];
    for (const gates of ALL_COMBINATIONS) {
      const flags = capabilityFlagsFrom(gates);
      const allFour =
        gates.g0_platform_verified &&
        gates.native_guard_verified &&
        gates.compatibility_section3_passed &&
        gates.g4_concurrency_fault_passed;
      const platformReady = gates.g0_platform_verified && gates.compatibility_section3_passed;
      assert.equal(
        flags.direct_write_enabled,
        allFour,
        `${shape(gates)} ⇒ direct_write=${flags.direct_write_enabled ? 1 : 0}，应当是 ${allFour ? 1 : 0}`,
      );
      // 读与提议**不看** native / g4 —— 少了这一条，「四项全真才开」这句话
      // 可以用一个「四个开关全都一样」的实现满足，而那会把读取也一起关掉。
      assert.equal(flags.read_enabled, platformReady, `${shape(gates)} ⇒ read`);
      assert.equal(flags.git_enabled, platformReady, `${shape(gates)} ⇒ git`);
      assert.equal(flags.proposal_enabled, platformReady, `${shape(gates)} ⇒ propose`);
      table.push(
        `${shape(gates)} ⇒ read=${flags.read_enabled ? 1 : 0} ` +
          `propose=${flags.proposal_enabled ? 1 : 0} direct=${flags.direct_write_enabled ? 1 : 0}`,
      );
    }
    assert.equal(table.length, 16, table.join('；'));
  });

  it('G4 未通过的那 8 格：直写一律为假，且另外三项**取什么值都不影响这一条**', () => {
    const off = ALL_COMBINATIONS.filter((g) => !g.g4_concurrency_fault_passed);
    assert.equal(off.length, 8);

    // 这 8 格里有几格是「不加上 G4 就会变成真」的？—— 那才是这条验收标准
    // 真正拦下的东西。必须是 2 格（g0=1 §3=1 native=1，g4 取 0/1 两格里的那一格），
    // 否则「G4 未通过时直写关着」可能只是因为别的项也没过。
    const wouldHaveBeenOn = off.filter(
      (g) => g.g0_platform_verified && g.native_guard_verified && g.compatibility_section3_passed,
    );
    assert.equal(
      wouldHaveBeenOn.length,
      1,
      `「另外三项全真、G4 未通过」这一格必须有且只有一格，实际 ${wouldHaveBeenOn.length}`,
    );

    for (const gates of off) {
      const flags = capabilityFlagsFrom(gates);
      assert.equal(flags.direct_write_enabled, false, `${shape(gates)} ⇒ 直写不该为真`);
    }
  });

  it('反向探针：那个开关**真的能**被算成真 —— 否则上面几格是空的', () => {
    // 没有这一条，一个 `direct_write_enabled: false` 写死的实现能让
    // 「16 格全对」成立。这与 LWB-031 §7.8d 是同一条理由。
    const allOn = capabilityFlagsFrom({
      g0_platform_verified: true,
      native_guard_verified: true,
      compatibility_section3_passed: true,
      g4_concurrency_fault_passed: true,
    });
    assert.equal(allOn.direct_write_enabled, true, '四项全真时直写必须为真，否则上一条是空话');
    // 而且**只差 G4 一项**就该把它关掉 —— 逐项回退，证明每一项都是必要的。
    for (const dimension of [
      'g0_platform_verified',
      'native_guard_verified',
      'compatibility_section3_passed',
      'g4_concurrency_fault_passed',
    ] as const) {
      const flags = capabilityFlagsFrom({
        g0_platform_verified: true,
        native_guard_verified: true,
        compatibility_section3_passed: true,
        g4_concurrency_fault_passed: true,
        [dimension]: false,
      });
      assert.equal(flags.direct_write_enabled, false, `把 ${dimension} 回退成假之后直写仍然为真`);
    }
  });

  it('生产那一份是**全关**的常量，而且它不是从任何运行时来源读出来的', () => {
    // ① 值：全关。
    assert.deepEqual(BRIDGE_GATES, {
      g0_platform_verified: false,
      native_guard_verified: false,
      compatibility_section3_passed: false,
      g4_concurrency_fault_passed: false,
    });
    assert.equal(BRIDGE_CAPABILITY_FLAGS.direct_write_enabled, false);
    assert.equal(BRIDGE_CAPABILITY_FLAGS.read_enabled, false);

    // ② 结构：门禁的来源是一个**字面常量**，不是一次读取。
    //
    // 这一条是「永远」二字的落点。值可以是假的，明天也可以被人改成真的
    // ——那是**一次代码变更**，留下评审记录，这正是设计要的。要防的是
    // 另一条路：某天有人加一句 `process.env.LWB_ALLOW_WRITE === '1'`，
    // 于是门禁就变成了「本机上有人把它打开了」的同义词。
    const source = readFileSync(path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'gates.ts'), 'utf8');
    // 先证明这段源码**真的**是门禁那一份（否则下面的扫描可能扫的是空气）。
    assert.match(source, /export const BRIDGE_GATES: PlatformGates = \{/, '没找到 BRIDGE_GATES 的字面定义');
    for (const forbidden of [
      'process.env',
      'readFileSync',
      'readFile(',
      'require(',
      'import(',
      'JSON.parse',
      'argv',
      'loadConfig',
      'from @lwb/persistence',
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `gates.ts 里出现了 ${forbidden} —— 门禁不能被运行时来源影响`,
      );
    }
    // 反向探针：同一个扫法去找一句**确实存在**的文本，必须找得到。
    // 没有这一句，一个「扫什么都返回 false」的探法也能让上面全绿。
    assert.equal(source.includes('g4_concurrency_fault_passed'), true, '反向探针：扫法本身失效了');
  });

  it('门禁未过时，限制说明里有一句点名 G4 —— 模型不该被蒙在鼓里', () => {
    const flags = capabilityFlagsFrom(BRIDGE_GATES);
    const lines = limitationsOf(flags, BRIDGE_GATES);
    assert.equal(
      lines.some((line) => line.includes('G4')),
      true,
      `限制说明里必须有 G4 那一条；实际：${lines.join(' | ')}`,
    );
    assert.ok(
      lines.some((line) => line.includes('G0 完整验收尚未通过') && line.includes('workspace_list')),
      'G0 限制文案必须区分元数据连接成功与真实内容读取验收',
    );
    assert.ok(
      lines.some((line) => line.includes('兼容性（§3）') && line.includes('读取、Git 与提议')),
      '限制说明必须点名与 G0 共同关闭读取能力的平台兼容性门禁',
    );
    assert.equal(
      lines.some((line) => line.includes('本工具面能否在网页端被发现与调用，未经验证')),
      false,
      '不得把已观察到的工具发现/元数据链路说成完全未验证',
    );
    // 反向探针：四项全过时那一句**不该**出现（否则这句是恒真的装饰）。
    const on = limitationsOf(
      capabilityFlagsFrom({
        g0_platform_verified: true,
        native_guard_verified: true,
        compatibility_section3_passed: true,
        g4_concurrency_fault_passed: true,
      }),
      {
        g0_platform_verified: true,
        native_guard_verified: true,
        compatibility_section3_passed: true,
        g4_concurrency_fault_passed: true,
      },
    );
    assert.equal(on.some((line) => line.includes('G4')), false, `门禁全过时不该再提 G4：${on.join(' | ')}`);
  });
});
