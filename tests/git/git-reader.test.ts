/**
 * 只读 Git 读取层的单元测试（LWB-016）。
 *
 * 这一层有两件事**必须在桩上测**，因为它们在真机上只会以「结果看起来正常」
 * 的形式出错：
 *
 *  1. **行解码**。`statusMatrix` 的三个数字不是布尔值，而是「该值在数组里
 *     第一次出现的下标」。读错它不会崩，只会把「索引里删了」说成「工作区
 *     里删了」—— 那是一条看起来完全正常的状态。
 *  2. **只读虚拟 fs**。「库没有写」这句话必须由**写通道不存在**来保证，
 *     而不是由「我们没写」来保证。桩能证明的是后者的反面：写方法被调用时
 *     会拒绝、会记账，并且**一次都没有碰护栏**（桩的调用计数为 0）。
 *
 * 真机上的那一半（真实 NTFS + 真实护栏 + 夹具仓库）在
 * `tests/windows/git-reader.test.ts`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BridgeError } from '@lwb/contracts';
import { LIMITS } from '@lwb/contracts';

import { byUtf8Bytes, createMetaFs, deriveRow, descends, assertReadOnlyLedger } from '@lwb/git-reader';
import type { MetaFs } from '@lwb/git-reader';

import { allowedDecision, dirOf, fileOf, makeOps, scopeOf, treeOf } from '../search/harness.ts';

// ---------------------------------------------------------------------------
// 行解码
// ---------------------------------------------------------------------------

/** 三棵树（HEAD / 索引 / 工作区）的每个可达组合 → 我们报出来的两个词。 */
const TABLE: readonly { readonly combo: readonly [number, number, number]; readonly head: string; readonly worktree: string; readonly porcelain: string }[] = [
  { combo: [0, 0, 0], head: 'absent', worktree: 'absent', porcelain: '(不产生行)' },
  { combo: [0, 0, 3], head: 'added', worktree: 'deleted', porcelain: 'AD' },
  { combo: [0, 2, 0], head: 'absent', worktree: 'untracked', porcelain: '??' },
  { combo: [0, 2, 2], head: 'added', worktree: 'unmodified', porcelain: 'A ' },
  { combo: [0, 2, 3], head: 'added', worktree: 'modified', porcelain: 'AM' },
  { combo: [1, 0, 0], head: 'deleted', worktree: 'absent', porcelain: 'D ' },
  { combo: [1, 0, 1], head: 'unmodified', worktree: 'deleted', porcelain: ' D' },
  { combo: [1, 0, 3], head: 'modified', worktree: 'deleted', porcelain: 'MD' },
  { combo: [1, 1, 0], head: 'deleted', worktree: 'untracked', porcelain: 'D + ??' },
  { combo: [1, 1, 1], head: 'unmodified', worktree: 'unmodified', porcelain: '  ' },
  { combo: [1, 1, 3], head: 'modified', worktree: 'modified', porcelain: 'M ' },
  { combo: [1, 2, 0], head: 'deleted', worktree: 'untracked', porcelain: 'D + ??' },
  { combo: [1, 2, 1], head: 'unmodified', worktree: 'modified', porcelain: ' M' },
  { combo: [1, 2, 2], head: 'modified', worktree: 'unmodified', porcelain: 'M ' },
  { combo: [1, 2, 3], head: 'modified', worktree: 'modified', porcelain: 'MM' },
];

describe('LWB-016 statusMatrix 行解码', () => {
  for (const row of TABLE) {
    const [h, w, s] = row.combo;
    it(`[${h},${w},${s}]（${row.porcelain}）→ head=${row.head} worktree=${row.worktree}`, () => {
      const derived = deriveRow(['some/file.txt', h as 0 | 1, w as 0 | 1 | 2, s as 0 | 1 | 2 | 3]);
      assert.equal(derived.head, row.head);
      assert.equal(derived.worktree, row.worktree);
      assert.equal(derived.path, 'some/file.txt');
    });
  }

  it('可达组合恰好 15 种：三种树的全部组合里只有这些能投影到三个下标上', () => {
    const reachable = new Set<string>();
    for (const h of [0, 1]) {
      for (const w of [0, 1, 2]) {
        for (const s of [0, 1, 2, 3]) {
          try {
            deriveRow(['f.txt', h as 0 | 1, w as 0 | 1 | 2, s as 0 | 1 | 2 | 3]);
            reachable.add(`${h},${w},${s}`);
          } catch {
            /* 不可达 */
          }
        }
      }
    }
    assert.equal(reachable.size, 15);
    assert.deepEqual(
      [...reachable].sort(),
      TABLE.map((r) => r.combo.join(',')).sort(),
      '表里列的组合必须与穷举结果逐字一致',
    );
  });

  it('9 种不可能的组合一律报 INTERNAL_ERROR，且**不猜**一个看起来正常的状态', () => {
    const impossible: readonly (readonly [number, number, number])[] = [
      [0, 0, 1],
      [0, 0, 2],
      [0, 1, 0],
      [0, 1, 1],
      [0, 1, 2],
      [0, 1, 3],
      [1, 0, 2],
      [1, 1, 2],
      [0, 2, 1],
    ];
    for (const [h, w, s] of impossible) {
      assert.throws(
        () => deriveRow(['secret-file.txt', h as 0 | 1, w as 0 | 1 | 2, s as 0 | 1 | 2 | 3]),
        (error: unknown) => {
          assert.ok(error instanceof BridgeError);
          assert.equal(error.code, 'INTERNAL_ERROR');
          assert.equal(error.details?.['reason'], 'UNEXPECTED_STATUS_ROW');
          assert.equal(error.details?.['combo'], `${h},${w},${s}`);
          // 前提正是「我们对库的理解已经不成立」，那就不能再假设这一行里的
          // 路径是一条可以回显的路径。
          assert.ok(!JSON.stringify(error).includes('secret-file.txt'), '错误里不得出现路径');
          return true;
        },
      );
    }
  });

  it('`1,1,3` 与 `1,2,3` 都读作 modified（下标 3 = 与 HEAD、工作区都不同）', () => {
    assert.deepEqual(deriveRow(['a.txt', 1, 1, 3]), { path: 'a.txt', head: 'modified', worktree: 'modified' });
    assert.deepEqual(deriveRow(['a.txt', 1, 2, 3]), { path: 'a.txt', head: 'modified', worktree: 'modified' });
  });

  it('`[1,2,2]`：只改了索引 ⇒ head=modified 而 worktree=unmodified', () => {
    assert.deepEqual(deriveRow(['a.txt', 1, 2, 2]), { path: 'a.txt', head: 'modified', worktree: 'unmodified' });
  });
});

// ---------------------------------------------------------------------------
// 只读虚拟 fs
// ---------------------------------------------------------------------------

const FS_LIMITS = {
  max_git_internal_file_bytes: LIMITS.MAX_GIT_INTERNAL_FILE_BYTES,
  max_worktree_file_bytes: LIMITS.MAX_READABLE_FILE_BYTES,
  max_worktree_read_bytes: LIMITS.MAX_GIT_STATUS_WORKTREE_BYTES,
};

/** 一个能跑的真实仓库形态：`.git` 内部 + 工作区，各自都有一点东西。 */
function repoTree() {
  return treeOf({
    '.git/HEAD': fileOf('ref: refs/heads/main\n'),
    '.git/index': fileOf('DIRC-fake-index-bytes'),
    '.git/config': fileOf('[core]\n\trepositoryformatversion = 0\n'),
    '.git/info/exclude': fileOf('# git ls-files --others --exclude-from=.git/info/exclude\n'),
    '.git/refs/heads/main': fileOf('5eefeeedc616b82927d6424c4d78e64a39c6b8dc\n'),
    '.git/hooks/pre-commit': fileOf('#!/bin/sh\necho hi\n'),
    '.git/logs/HEAD': fileOf('0000 1111 someone\n'),
    // 对象路径必须写成**真实的形状**：`GIT_FILE_ALLOW` 要的是
    // `.git/objects/<2 位十六进制>/<38 位十六进制>`，也就是一个完整的
    // oid。写成 `ab/cdef` 会被清单判为「不是对象路径」—— 见下面的用例。
    '.git/objects/5e/efeeedc616b82927d6424c4d78e64a39c6b8dc': fileOf('zlib-ish'),
    '.git/objects/pack/pack-5eefeeedc616b82927d6424c4d78e64a39c6b8dc.pack': fileOf('PACK'),
    'README.md': fileOf('# readme\n'),
    'src/main.ts': fileOf('export const x = 1;\n'),
    'src/.gitignore': fileOf('dist/\n'),
    '.env': fileOf('TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n'),
    'config/.env.example': fileOf('TOKEN=\n'),
    'nested/.env': fileOf('A=1\n'),
    'src/locked.txt': fileOf('locked\n', { busy_on_read: true }),
    'src/huge.bin': fileOf('x', { size_override: LIMITS.MAX_READABLE_FILE_BYTES + 1 }),
    'src/link.txt': fileOf('target\n', { is_reparse: true }),
  });
}

function metaOf(): { meta: MetaFs; ops: ReturnType<typeof makeOps> } {
  const stub = makeOps(repoTree());
  const meta = createMetaFs({
    ops: stub.ops,
    scope: scopeOf(),
    rules: allowedDecision('git_status').rules,
    limits: FS_LIMITS,
  });
  return { meta, ops: stub };
}

const PROMISES = (meta: MetaFs) => meta.client.promises as unknown as Record<string, (p: string, ...rest: unknown[]) => Promise<unknown>>;

/**
 * 库给的是**绝对路径**：`.git` 内部走 `path.join(dir, '.git', …)`，
 * 工作区走 `path.join(dir, filepath)`，只有遍历根那一处是 `${dir}/.` 的
 * 前斜杠拼接。因此本文件的 `.git/**` 用例也一律按绝对路径调用 —— 传相对
 * 路径测到的是另一回事（那本来就不在契约里，也不该被当成正常调用）。
 */
function abs(rel: string): string {
  return `C:\\work\\proj\\${rel.replace(/\//g, '\\')}`;
}

describe('LWB-016 只读虚拟 fs：写通道不存在', () => {
  const WRITES = [
    'writeFile',
    'unlink',
    'mkdir',
    'rmdir',
    'rm',
    'cp',
    'symlink',
    'chmod',
    'rename',
    'appendFile',
    'truncate',
    'utimes',
  ] as const;

  it('12 个写方法全部拒绝、全部带错误码、全部记账', async () => {
    const { meta } = metaOf();
    for (const method of WRITES) {
      const fn = PROMISES(meta)[method];
      assert.equal(typeof fn, 'function', `库的契约要求 ${method} 存在`);
      await assert.rejects(
        async () => fn!('.git/index'),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'EPERM', `${method} 必须拒绝`);
          return true;
        },
      );
    }
    assert.equal(meta.ledger.refused_writes.length, WRITES.length);
  });

  it('写调用**一次都没有碰护栏**（拒绝发生在到达后端之前）', async () => {
    const { meta, ops } = metaOf();
    await PROMISES(meta)['writeFile']!('.git/index').catch(() => undefined);
    await PROMISES(meta)['unlink']!('src/main.ts').catch(() => undefined);
    assert.equal(ops.calls.resolve, 0);
    assert.equal(ops.calls.read, 0);
    assert.equal(ops.calls.list, 0);
  });

  it('账本非空 ⇒ 整次调用失败，且只报次数不报路径', async () => {
    const { meta } = metaOf();
    await PROMISES(meta)['writeFile']!('secret-plans.md').catch(() => undefined);
    assert.throws(
      () => assertReadOnlyLedger(meta),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INTERNAL_ERROR');
        assert.equal((error as { details?: Record<string, unknown> }).details?.['reason'], 'READONLY_FS_WRITE_ATTEMPT');
        assert.equal((error as { details?: Record<string, unknown> }).details?.['attempts'], 1);
        assert.ok(!JSON.stringify(error).includes('secret-plans.md'), '不得回显被拒的路径');
        return true;
      },
    );
  });

  it('干净的账本上断言不抛（否则每次正常查询都会被它炸掉）', () => {
    const { meta } = metaOf();
    assert.doesNotThrow(() => assertReadOnlyLedger(meta));
  });

  it('readlink 也拒绝：不跟随链接，因此没有「读链接目标」这条通道', async () => {
    const { meta } = metaOf();
    await assert.rejects(async () => PROMISES(meta)['readlink']!('src/link.txt'));
    assert.ok(meta.ledger.refused_reads.some((r) => r.startsWith('readlink')));
  });
});

describe('LWB-016 只读虚拟 fs：`.git` 内部是窄范围清单', () => {
  const cases: readonly { readonly path: string; readonly allowed: boolean; readonly why: string }[] = [
    { path: '.git/HEAD', allowed: true, why: '解析当前提交需要' },
    { path: '.git/index', allowed: true, why: '比对索引需要' },
    { path: '.git/refs/heads/main', allowed: true, why: '解析 ref 需要' },
    { path: '.git/info/exclude', allowed: true, why: 'ignore 走查需要' },
    {
      path: '.git/objects/5e/efeeedc616b82927d6424c4d78e64a39c6b8dc',
      allowed: true,
      why: '对象读取需要（由 oid 拼出的路径）',
    },
    {
      path: '.git/objects/pack/pack-5eefeeedc616b82927d6424c4d78e64a39c6b8dc.pack',
      allowed: true,
      why: '打包对象需要',
    },
    {
      path: '.git/objects/ab/cdef',
      allowed: false,
      why: '**形状**也是清单的一部分：要 40 位十六进制。放行任意名字等于放行 `.git/objects/` 下的全部文件',
    },
    { path: '.git/config', allowed: false, why: 'HD-GIT-CONFIG：core.* 决定了我们**不打算支持**的语义' },
    { path: '.git/hooks/pre-commit', allowed: false, why: '本层不执行 hooks，也就没有理由读它' },
    { path: '.git/logs/HEAD', allowed: false, why: 'reflog 不在只读状态/差异所需范围内' },
  ];

  for (const item of cases) {
    it(`${item.path} ${item.allowed ? '可读' : '不可读'} —— ${item.why}`, async () => {
      const { meta } = metaOf();
      const read = PROMISES(meta)['readFile']!(abs(item.path));
      if (item.allowed) {
        const bytes = (await read) as Uint8Array;
        assert.ok(bytes.length > 0);
      } else {
        await assert.rejects(async () => read, (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'ENOENT', '不在清单里的路径报告「不存在」');
          return true;
        });
        assert.ok(meta.ledger.refused_reads.includes(item.path), '每一次拒绝都要留痕');
      }
    });
  }

  it('`.git` 内部路径的**拼写变体**同样落在清单里判定', async () => {
    const { meta } = metaOf();
    // `.git/./config` 必须先归一化再判定。顺序反过来（先判后归一）就是一条
    // 绕过窄范围清单的路：判的时候看到的是 `.git/./config`，读的时候是 `.git/config`。
    await assert.rejects(async () => PROMISES(meta)['readFile']!(abs('.git/./config')));
    await assert.rejects(async () => PROMISES(meta)['readFile']!(abs('src/../.git/config')));
    assert.equal(meta.ledger.refused_reads.includes('.git/config'), true, '归一化之后仍要记账成 `.git/config`');
  });
});

describe('LWB-016 相对路径归一化', () => {
  it('库在根节点上拼出来的 `<root>/.` 认作工作区根，而不是 ENOENT', async () => {
    const { meta } = metaOf();
    // `GitWalkerFs.stat` 拼的是 `${dir}/${entry._fullpath}`，而遍历的根节点
    // `_fullpath` 就是 `'.'`。不认这个拼写，`statusMatrix` 会在遍历的第一步
    // 就报 `lstat '.'` 失败 —— 看起来像路径没传对。
    const stat = (await PROMISES(meta)['lstat']!('C:\\work\\proj/.')) as { isDirectory: () => boolean };
    assert.equal(stat.isDirectory(), true);
    const names = (await PROMISES(meta)['readdir']!('C:\\work\\proj/.')) as string[];
    assert.ok(names.includes('README.md'));
  });

  it('`..` 段一律拒绝（它真的能走出工作区，与 `.` 不同）', async () => {
    const { meta } = metaOf();
    await assert.rejects(async () => PROMISES(meta)['readFile']!('C:\\work\\proj/../outside.txt'));
    await assert.rejects(async () => PROMISES(meta)['readFile']!('C:\\work\\proj/src/../../outside.txt'));
  });

  it('工作区之外的绝对路径拒绝', async () => {
    const { meta } = metaOf();
    await assert.rejects(async () => PROMISES(meta)['readFile']!('C:\\work\\other\\file.txt'));
    await assert.rejects(async () => PROMISES(meta)['readFile']!('D:\\work\\proj\\file.txt'));
  });

  it('`descends` 按路径段边界判，且根节点单独放行', () => {
    assert.equal(descends('.', 'anything/at/all.txt'), true);
    assert.equal(descends('src', 'src/main.ts'), true);
    assert.equal(descends('src', 'src'), false, '自己不算「在自己的子树里」');
    assert.equal(descends('src', 'src2/main.ts'), false, '裸前缀不是子树');
    assert.equal(descends('src/sub', 'src/sub/deep/x.ts'), true);
  });

  it('`byUtf8Bytes` 与 Git 索引的 memcmp 同序（不是 UTF-16 码元序）', () => {
    // 差异只在基本平面之外出现：代理对编码成 4 字节，码元序会把 U+10000 排在
    // U+E000 前面，而字节序不会。排序判据错了的后果是「某些文件从结果里消失」。
    assert.ok(byUtf8Bytes('\u{10000}', '\uE000') > 0);
    assert.ok(byUtf8Bytes('a', 'b') < 0);
    assert.equal(byUtf8Bytes('文档', '文档'), 0);
  });
});

describe('LWB-016 工作区读取：硬拒绝与「没能比对」', () => {
  it('硬拒绝的路径走 readWorktreeFile 也读不到（判在策略层，不是判在 Git 层）', async () => {
    const { meta } = metaOf();
    await assert.rejects(
      async () => meta.readWorktreeFile('.env'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'POLICY_DENIED');
        return true;
      },
    );
    await assert.rejects(async () => meta.readWorktreeFile('config/.env.example'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'POLICY_DENIED', '.env.example 不是自动豁免的');
      return true;
    });
    await assert.rejects(async () => meta.readWorktreeFile('nested/.env'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'POLICY_DENIED');
      return true;
    });
  });

  it('按工作区路径读 `.git` 内部是**入参错误**，不是「文件不存在」', async () => {
    const { meta } = metaOf();
    await assert.rejects(async () => meta.readWorktreeFile('.git/HEAD'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT');
      assert.equal((error as { details?: Record<string, unknown> }).details?.['reason'], 'NOT_A_WORKTREE_PATH');
      return true;
    });
  });

  it('目录列举时被摘掉的名字进策略隐藏集（它从来没变成一行）', async () => {
    const { meta } = metaOf();
    const names = (await PROMISES(meta)['readdir']!('C:\\work\\proj')) as string[];
    assert.ok(!names.includes('.env'), '硬拒绝的名字不出现在列举里');
    assert.ok(names.includes('README.md'));
    assert.deepEqual(meta.policyHiddenPaths(), ['.env']);
  });

  it('取不到身份的文件记进 exclusions 并给出原因，而**不是**让它变成一行假状态', async () => {
    const { meta } = metaOf();
    // 最真实的一种：**列举与 stat 之间被删掉了**。护栏对不存在的路径答
    // NOT_FOUND，而这是常态（另一个进程刚刚删了它），因此不能把整次查询炸掉。
    await PROMISES(meta)['lstat']!('C:\\work\\proj/src/vanished.txt');
    const exclusions = meta.exclusions();
    assert.equal(exclusions.length, 1);
    assert.equal(exclusions[0]?.path, 'src/vanished.txt');
    assert.equal(exclusions[0]?.reason, 'IDENTITY_UNAVAILABLE');
  });

  it('超过单文件比对上限的文件记成 FILE_TOO_LARGE（受控句柄只有整文件读取）', async () => {
    const { meta } = metaOf();
    await PROMISES(meta)['lstat']!('C:\\work\\proj/src/huge.bin');
    assert.equal(meta.exclusions()[0]?.reason, 'FILE_TOO_LARGE');
  });

  it('被独占的文件在**比对读取**上给 EBUSY，而不是静默当成空内容', async () => {
    const { meta } = metaOf();
    await assert.rejects(async () => meta.readWorktreeFile('src/locked.txt'), (error: unknown) => {
      // 读不到**内容**与取不到**身份**是两件事：前者发生在比对那一刻，
      // 除了报错没有别的可做（`git_diff` 因此整侧失败），后者可以在遍历里
      // 单列出来。混为一谈就会把「读不到」说成「没有变化」。
      assert.equal((error as { code?: string }).code, 'EBUSY');
      return true;
    });
  });

  it('重解析点记成 LINK_UNSUPPORTED（不跟随链接，因此不对它做比对）', async () => {
    const { meta } = metaOf();
    await PROMISES(meta)['lstat']!('C:\\work\\proj/src/link.txt');
    assert.equal(meta.exclusions()[0]?.reason, 'LINK_UNSUPPORTED');
  });
});

describe('LWB-016 meta-fs 的缓存与账本', () => {
  it('同一个 `oid` 的重复读取命中缓存，护栏只被问一次', async () => {
    const { meta, ops } = metaOf();
    const oid = '.git/objects/5e/efeeedc616b82927d6424c4d78e64a39c6b8dc';
    await PROMISES(meta)['readFile']!(abs(oid));
    await PROMISES(meta)['readFile']!(abs(oid));
    assert.equal(ops.calls.read, 1);
    assert.equal(meta.ledger.git_cache_hits, 1);
  });

  it('每次 `.git` 读取与每次工作区**读取**都留在账本里（用于证明「什么都没读」）', async () => {
    const { meta } = metaOf();
    await PROMISES(meta)['readFile']!(abs('.git/HEAD'));
    await PROMISES(meta)['readFile']!('C:\\work\\proj/README.md');
    assert.deepEqual(meta.ledger.git_reads, ['.git/HEAD']);
    assert.deepEqual(meta.ledger.worktree_reads, ['README.md']);
    assert.deepEqual(meta.ledger.worktree_listings, []);
  });
});
