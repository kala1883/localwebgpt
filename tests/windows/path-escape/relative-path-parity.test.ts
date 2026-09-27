/**
 * 相对路径语法的**两份实现一致性测试**（LWB-010 步骤 1）。
 *
 * ## 这个测试在防什么
 *
 * 路径语法规则有两份独立实现：
 *   - `packages/contracts/src/path.ts`（调用方侧，TypeScript）
 *   - `native/winfs/path_guard/RelativePath.ps1`（护栏侧，PowerShell）
 *
 * 两份实现是**刻意的**，不是重复劳动：护栏是独立进程，请求经管道到达，
 * 它的边界是它自己打开的那个句柄。调用方被绕过、被替换、或者将来某个新的
 * 调用点忘了先跑一遍 contracts 的校验时，护栏必须仍然拒绝。
 *
 * 代价是漂移风险。这个文件就是那个代价的处置方式：同一份语料
 * （`native/winfs/path_guard/corpus.ts`）分别喂给两侧，逐例断言
 * **结论与理由完全一致**。任何一侧被改松或改紧，这里立刻变红。
 *
 * ## 为什么断言到「理由」而不只是「拒没拒」
 *
 * 「都拒了」是很容易达成的假一致：把两侧都写成一个 `if (path.includes('..'))
 * return false` 也能全绿。理由一致才说明**规则本身**一致 ——
 * 而理由也是给模型和用户看的解释，理由错了，解释就是错的。
 *
 * ## 关于「护栏真的被调用了吗」
 *
 * 会。这里调用的是 `PowerShellWinfsBackend.validatePath`，它把请求原样写进
 * 常驻 pwsh 进程的管道，读回护栏的答复。没有任何一层会在 TS 侧先跑一遍
 * contracts 校验再决定发不发 —— 也就是说，这个测试量到的就是护栏自己的判定。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { validateRelativePath, type PathRejectReason } from '@lwb/contracts';
import { PowerShellWinfsBackend } from '@lwb/winfs';

import { PATH_CORPUS, type CorpusCase } from '../../../native/winfs/path_guard/corpus.ts';

const isWindows = process.platform === 'win32';
const describeWindows = isWindows ? describe : describe.skip;

/** 两份实现各自的判定，归一成同一个形状以便逐字段比较。 */
interface Verdict {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly normalized: string | null;
  readonly segments: readonly string[] | null;
}

/** 调用方侧（contracts）的判定。 */
function verdictTs(c: CorpusCase): Verdict {
  const v = validateRelativePath(c.input);
  return v.ok
    ? { ok: true, reason: null, normalized: v.normalized, segments: v.segments }
    : { ok: false, reason: v.reason, normalized: null, segments: null };
}

/**
 * 护栏侧的判定。
 *
 * `c.input` 声明为 `unknown` 是刻意的：非字符串输入（null、数字、数组）
 * 也在验收面上，所以这里**故意**把它原样送过去，而不是先断言成字符串。
 * 类型系统挡住的东西，跨进程的边界上挡不住 —— 护栏必须自己判。
 */
async function verdictGuard(
  backend: PowerShellWinfsBackend,
  c: CorpusCase,
): Promise<Verdict> {
  const v = await backend.validatePath({ relative_path: c.input as string });
  return v.ok
    ? { ok: true, reason: null, normalized: v.normalized, segments: v.segments }
    : { ok: false, reason: v.reason, normalized: null, segments: null };
}

describeWindows('LWB-010 步骤 1：相对路径语法的两份实现一致性', () => {
  let backend: PowerShellWinfsBackend;

  before(async () => {
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(
      capability.available,
      true,
      `护栏后端不可用，无法验证护栏侧规则：${capability.resolved_backend_reason}`,
    );
  });

  after(async () => {
    await backend?.dispose();
  });

  it('语料本身非空，且正负用例都有', () => {
    // 先证明测试有东西可测。空语料的全绿是「假 PASS」的经典形态。
    assert.ok(PATH_CORPUS.length >= 50, `语料只有 ${PATH_CORPUS.length} 条，太少`);
    const accepted = PATH_CORPUS.filter((c) => c.reason === null).length;
    const rejected = PATH_CORPUS.length - accepted;
    assert.ok(accepted >= 8, `正向用例只有 ${accepted} 条 —— 全是拒绝用例的话，规则可以退化成「一律拒绝」`);
    assert.ok(rejected >= 30, `负向用例只有 ${rejected} 条`);
  });

  for (const c of PATH_CORPUS) {
    it(`两侧一致：${c.name}`, async () => {
      const ts = verdictTs(c);
      const guard = await verdictGuard(backend, c);

      // 1) 先断言各自符合语料的期望 —— 否则「两侧一致」可能是一起错。
      assert.equal(
        ts.ok,
        c.reason === null,
        `contracts 侧结论与语料不符（${c.name}）：期望${c.reason === null ? '接受' : `拒绝（${c.reason}）`}，实际${ts.ok ? '接受' : `拒绝（${ts.reason}）`}。用例意图：${c.why}`,
      );
      assert.equal(
        guard.ok,
        c.reason === null,
        `护栏侧结论与语料不符（${c.name}）：期望${c.reason === null ? '接受' : `拒绝（${c.reason}）`}，实际${guard.ok ? '接受' : `拒绝（${guard.reason}）`}。用例意图：${c.why}`,
      );

      // 2) 拒绝时理由必须逐字相同。
      if (c.reason !== null) {
        assert.equal(
          ts.reason,
          c.reason,
          `contracts 侧理由不符（${c.name}）`,
        );
        assert.equal(
          guard.reason,
          c.reason,
          `护栏侧理由不符（${c.name}）：期望 ${c.reason}，实际 ${guard.reason}`,
        );
        // 3) 两侧之间也必须相同 —— 上面两条各自对齐语料后，这条才是
        //    「两份实现一致」的直接表述。
        assert.equal(
          guard.reason,
          ts.reason,
          `两侧理由分叉（${c.name}）：contracts=${ts.reason}，护栏=${guard.reason}`,
        );
        return;
      }

      // 4) 接受时规范化结果与分段必须一致。
      assert.equal(
        guard.normalized,
        ts.normalized,
        `两侧规范化结果分叉（${c.name}）`,
      );
      assert.equal(guard.normalized, c.normalized, `护栏侧规范化结果与语料不符（${c.name}）`);
      assert.deepEqual(
        guard.segments,
        ts.segments,
        `两侧分段结果分叉（${c.name}）`,
      );
      assert.deepEqual(
        guard.segments,
        c.segments,
        `护栏侧分段结果与语料不符（${c.name}）`,
      );
    });
  }

  it('语料里的每一个理由标签都被至少一条用例覆盖（防止新增规则时忘了补用例）', () => {
    const covered = new Set(PATH_CORPUS.map((c) => c.reason).filter((r): r is PathRejectReason => r !== null));
    // 这些是**当前**规则集里的全部理由。新增一个理由而没补用例时，
    // 这条断言会提醒：新规则没有可复现的验收面。
    const expected: readonly PathRejectReason[] = [
      'NOT_A_STRING',
      'INVISIBLE_CHAR',
      'EMPTY',
      'TOO_LONG',
      'TOO_DEEP',
      'SEGMENT_TOO_LONG',
      'ABSOLUTE',
      'UNC',
      'DEVICE_NAMESPACE',
      'DRIVE_LETTER',
      'ADS_COLON',
      'PARENT_REF',
      'DOT_SEGMENT',
      'EMPTY_SEGMENT',
      'TRAILING_SEPARATOR',
      'CONTROL_CHAR',
      'INVALID_CHAR',
      'TRAILING_DOT_OR_SPACE',
      'RESERVED_NAME',
    ];
    const missing = expected.filter((r) => !covered.has(r));
    assert.deepEqual(missing, [], `以下理由没有任何语料用例：${missing.join(', ')}`);
  });
});
