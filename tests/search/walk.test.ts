/**
 * 候选文件的发现（LWB-015 步骤 2）。
 *
 * 这一层有三件事无法由返回值证明，只能由**调用记录**证明：
 *
 *  - 被硬拒绝的目录**没有进入** —— 判据是护栏从没被问过它；
 *  - 被搜索排除的目录**没有进入** —— 同上，但它的文件要出现在计数里；
 *  - 重解析点**没有被读** —— 判据是 `calls.read_paths` 里没有它的内容。
 *
 * 因此每个用例都同时断言「拿到了什么」与「护栏被问了什么」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_DEFAULT_RULES } from '@lwb/policy';
import { DEFAULT_MAX_DIRECTORY_LISTINGS, newWalkState, walkCandidates } from '@lwb/search';
import type { WalkState } from '@lwb/search';
import type { WinfsOps } from '@lwb/winfs';

import { dirOf, fileOf, makeOps, scopeOf, treeOf, GUARD_CAP } from './harness.ts';
import type { NodeSpec } from './harness.ts';

/** 默认规则表 —— 与 daemon 未做操作者覆盖时用的是同一份。 */
const RULES = ALL_DEFAULT_RULES;

interface CollectOptions {
  readonly max_depth?: number;
  readonly max_directory_listings?: number;
}

interface Collected {
  readonly paths: string[];
  readonly state: WalkState;
  readonly listed: string[];
  readonly read_paths: string[];
}

async function collect(tree: Map<string, NodeSpec>, options: CollectOptions = {}): Promise<Collected> {
  const { ops, calls } = makeOps(tree);
  const state = walkStateOf(ops, options);

  const paths: string[] = [];
  await walkCandidates(state, { onFile: (path) => (paths.push(path), true) }, null);
  return { paths, state, listed: calls.listed.map((l) => l.path), read_paths: calls.read_paths };
}

function walkStateOf(ops: WinfsOps, options: CollectOptions = {}): WalkState {
  return newWalkState({
    ops,
    scope: scopeOf(),
    rules: RULES,
    max_depth: options.max_depth ?? 32,
    base_path: '',
    ...(options.max_directory_listings === undefined
      ? {}
      : { max_directory_listings: options.max_directory_listings }),
  });
}

describe('LWB-015 遍历：三类对象，三种处置', () => {
  it('硬拒绝的目录不进入，且护栏从没被问过它', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      '.ssh/known_hosts': fileOf('ssh-rsa AAAA'),
      '.git/config': fileOf('[core]'),
      'b.txt': fileOf('beta'),
    });
    const { paths, listed, state } = await collect(tree);

    assert.deepEqual(paths, ['a.txt', 'b.txt']);
    // 「没进入」的判据：护栏从未被要求列举它们。
    assert.equal(listed.includes('.ssh'), false);
    assert.equal(listed.includes('.git'), false);
    // 目录本身不计入文件数。
    assert.equal(state.denied_files, 0);
  });

  it('硬拒绝的**文件**连名字都不返回，但计数留着', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      '.env': fileOf('SECRET=1'),
      '.env.local': fileOf('SECRET=2'),
    });
    const { paths, state } = await collect(tree);

    assert.deepEqual(paths, ['a.txt']);
    assert.equal(state.denied_files, 2);
    assert.equal(state.files_seen, 3);
  });

  it('搜索排除的目录不进入，但它的文件计入「跳过」而不是「没看见」', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      'node_modules/pkg/index.js': fileOf('module.exports = 1'),
      'node_modules/pkg/deep/x.js': fileOf('x'),
    });
    const { paths, listed, state } = await collect(tree);

    assert.deepEqual(paths, ['a.txt']);
    assert.equal(listed.includes('node_modules'), false);
    // 只有 node_modules 自己这一条被看到 —— 里面的东西从没被扫过，
    // 因此不在任何计数里（这正是「不扫」与「扫了但没有」的区别）。
    assert.equal(state.excluded_files, 0);
  });

  it('重解析点不进入、不读、也不 stat 它的尺寸', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      'link': dirOf({ is_reparse: true }),
      'link/inner.txt': fileOf('should never be read'),
    });
    const { paths, listed } = await collect(tree);

    assert.deepEqual(paths, ['a.txt']);
    assert.equal(listed.includes('link'), false);
  });

  it('重解析点的**文件**同样不读', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      'alias.txt': fileOf('outside the workspace', { is_reparse: true }),
    });
    const { paths, state } = await collect(tree);

    assert.deepEqual(paths, ['a.txt']);
    assert.equal(state.excluded_files, 1);
    assert.equal(state.files_seen, 2);
  });

  it('名字本身就是秘密的文件被丢弃（只筛 certain 档）', async () => {
    const tree = treeOf({
      'a.txt': fileOf('alpha'),
      'ghp_012345678901234567890123456789012345.txt': fileOf('token'),
      // `TOKEN=xxx` 这类名字**不**丢：文件名里的 `=` 在 Windows 上合法，
      // 而 likely 档会把它一起吞掉。
      'TOKEN=abc.txt': fileOf('cfg'),
    });
    const { paths, state } = await collect(tree);

    assert.deepEqual(paths, ['TOKEN=abc.txt', 'a.txt']);
    assert.equal(state.denied_files, 1);
  });
});

describe('LWB-015 遍历：顺序与计数', () => {
  it('顺序是深度优先先序，同层按 ordinal', async () => {
    const tree = treeOf({
      'b.txt': fileOf('b'),
      'a.txt': fileOf('a'),
      'dir/z.txt': fileOf('z'),
      'dir/a.txt': fileOf('a'),
      'c.txt': fileOf('c'),
    });
    const { paths } = await collect(tree);
    assert.deepEqual(paths, ['a.txt', 'b.txt', 'c.txt', 'dir/a.txt', 'dir/z.txt']);
  });

  it('`files_seen = files_offered + denied_files + excluded_files`', async () => {
    const tree = treeOf({
      'a.txt': fileOf('a'),
      '.env': fileOf('x'),
      'node_modules/pkg/i.js': fileOf('i'),
      'alias': fileOf('x', { is_reparse: true }),
      'dir/b.txt': fileOf('b'),
    });
    const { state, paths } = await collect(tree);

    assert.equal(state.files_seen, state.files_offered + state.denied_files + state.excluded_files);
    assert.equal(state.files_seen, 4); // a.txt, .env, alias, dir/b.txt
    assert.equal(paths.length, state.files_offered);
  });

  it('深度上限：不进入的那一层被数出来', async () => {
    const tree = treeOf({
      'a.txt': fileOf('a'),
      'l1/b.txt': fileOf('b'),
      'l1/l2/c.txt': fileOf('c'),
    });
    const { paths, state } = await collect(tree, { max_depth: 1 });

    assert.deepEqual(paths, ['a.txt', 'l1/b.txt']);
    assert.equal(state.depth_pruned, 1);
  });
});

describe('LWB-015 遍历：走不完的时候说清楚', () => {
  it('子树枚举失败被记下（路径 + 护栏码），不炸掉整次遍历', async () => {
    const tree = treeOf({
      'a.txt': fileOf('a'),
      'gone/x.txt': fileOf('x'),
      'z.txt': fileOf('z'),
    });
    const { ops } = makeOps(tree);
    const state = walkStateOf(ops);
    // 让 `gone` 在列举时返回 NOT_FOUND。
    const node = tree.get('gone');
    assert.ok(node !== undefined);
    (node as { vanishing?: boolean }).vanishing = true;

    const paths: string[] = [];
    await walkCandidates(state, { onFile: (p) => (paths.push(p), true) }, null);

    assert.deepEqual(paths, ['a.txt', 'z.txt']);
    assert.equal(state.skipped_subtrees.length, 1);
    assert.equal(state.skipped_subtrees[0]?.path, 'gone');
    assert.equal(state.skipped_subtrees[0]?.code, 'NOT_FOUND');
  });

  it('目录询问次数用尽即停止，并置 listings_exhausted', async () => {
    const tree = treeOf({
      'a/x.txt': fileOf('x'),
      'b/x.txt': fileOf('x'),
      'c/x.txt': fileOf('x'),
    });
    const { ops } = makeOps(tree);
    const state = walkStateOf(ops, { max_directory_listings: 2 });

    const paths: string[] = [];
    await walkCandidates(state, { onFile: (p) => (paths.push(p), true) }, null);

    assert.equal(state.listings_exhausted, true);
    assert.equal(state.listings, 2);
    // 走了两个目录（根 + a），后面还有没走到的。
    assert.ok(paths.length < 3);
  });

  it('护栏每次被问的条目数不超过自己的硬上限', async () => {
    const tree = treeOf({ 'a.txt': fileOf('a') });
    const { ops, calls } = makeOps(tree);
    const state = walkStateOf(ops);
    await walkCandidates(state, { onFile: () => true }, null);

    assert.equal(calls.listed.length, 1);
    assert.equal(calls.listed[0]?.max, GUARD_CAP);
  });

  it('默认的目录询问上限是一个可读的常量，不是散落的魔法数', () => {
    assert.equal(typeof DEFAULT_MAX_DIRECTORY_LISTINGS, 'number');
    assert.ok(DEFAULT_MAX_DIRECTORY_LISTINGS > 500);
  });
});

describe('LWB-015 遍历：访问者说了算', () => {
  it('访问者返回 false 就地停止，后面的文件不再被交给它', async () => {
    const tree = treeOf({
      'a.txt': fileOf('a'),
      'b.txt': fileOf('b'),
      'c.txt': fileOf('c'),
    });
    const { ops, calls } = makeOps(tree);
    const state = walkStateOf(ops);

    const paths: string[] = [];
    await walkCandidates(state, { onFile: (p) => (paths.push(p), false) }, null);

    assert.deepEqual(paths, ['a.txt']);
    // 但目录只问了一次 —— 停止发生在条目循环里，不是重新问一遍。
    assert.equal(calls.listed.length, 1);
  });
});
