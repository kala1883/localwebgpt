/**
 * LWB-033 · 断网：这一格在执行段里**没有故障面** —— 而这句话本身是可以查的。
 *
 * ## 为什么不写一个「拔掉网线再写一次」的用例
 *
 * 因为那个用例要证明的是「这条路上没有网络」，而它测出来的是「断网时它还
 * 能写」。两句话不一样：后者换一台有网的机器、换一个被劫持的 DNS 照样绿，
 * 而执行段里到底有没有一个 `fetch`，那个用例一个字都没说。
 *
 * 这里要证明的是一件**结构性**的事：一次写入的字节从批准记录走到磁盘，
 * 沿途**没有任何一个网络调用点**。于是「断网」不是这个执行段的输入 ——
 * 拔不拔网线对它的行为没有影响。这不是一条关于断网的经验结论，而是一条
 * 关于代码的事实。
 *
 * ## 四组断言
 *
 *  - **A. 直接边**：执行段自己的源码里没有任何网络导入，也没有任何
 *    「不需要导入的网络调用」（全局 `fetch` / `WebSocket` / `XMLHttpRequest`
 *    这类，它们不经过 import，因此只看 import 会漏）。
 *  - **B. 反向探针**：拿**真文件**里真的存在的网络导入喂给同一个检测函数，
 *    它必须报出来 —— 没有这一组，一个恒假的检测函数会让 A 全绿。
 *  - **C. 传递边**：执行段的工作区传递闭包里**只有 `@lwb/ipc` 一个包**碰网络。
 *    这一条**不是清白证明，是一份如实的豁免**：执行段从 `@lwb/ipc` 取成员，
 *    而这个包的 barrel `index.ts` 把三个「连接」文件一起转出，于是 `node:net`
 *    确实会进到执行段的模块图里 —— 只是被**加载**，没有任何一处调用。
 *    判据因此落在「执行段取用的成员与那三个文件的导出不相交」上。
 *  - **D. 那份 ps1**：执行段的源码不止 `src/*.ts`，还有被它拉起来的护栏助手
 *    `native/winfs/WinfsGuard.ps1`。它同样没有任何网络 cmdlet。
 *
 * ## 检测是**文本级**的：它只会多报，不会漏报
 *
 * 判据是正则，因此一句注释里写出 `fetch(` 也会被算作命中。对一条「必须为零」
 * 的断言来说这是安全的方向：多报会当场吵，而漏报会静默放过 —— 后者是这份
 * 文件唯一不能接受的结果。反过来，量词都带词边界，`fetchRows(` 与
 * `refetched` 不会被误伤（B 组的自查里逐条钉住）。
 *
 * ## 这一组**不**证明什么
 *
 *  - 不证明依赖树里没有网络实现（`better-sqlite3` 这类原生模块、Node 自身）。
 *    那是依赖清单那一层的事，不在这条边上。
 *  - 不证明「本机这一侧不会失败」。执行段要用本地命名管道与本地进程，那些
 *    东西不在的时候它当然会失败 —— 但那是「服务退出」那一格，不是「断网」。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * 执行段：一次写入会经过的**自己的**源码。
 *
 * 边界画在「谁会被写路径加载」上，而不是画在目录名上：
 *  - `packages/executor`（分类与回滚）、`changes`（修改集与内容读出）、
 *    `approvals`（一次性批准）、`persistence`（状态库）、`blob-store`（对象）
 *    五者是执行链本身；
 *  - `@lwb/winfs`（后端与助手客户端）是第六者，但它**住在 `native/winfs`** ——
 *    包名与目录层在这一处不一致，因此这里按包名找目录（见 `packageDir`），
 *    而不是按人手写死的路径。
 *
 * `apps/daemon` 不在里面：它是装配根与宿主，不是执行段 —— 但它确实有网络
 * 导入（命名管道服务器），因此它是 B 组最好的反向探针。
 */
const EXECUTION_ROOTS: readonly string[] = [
  'packages/executor/src',
  'packages/persistence/src',
  'packages/blob-store/src',
  'packages/approvals/src',
  'packages/changes/src',
  'native/winfs/src',
].map((rel) => path.join(ROOT, ...rel.split('/')));

/** 护栏助手：执行段源码的 PowerShell 那一半（`HELPER_PATH` 指向它）。 */
const GUARD_HELPER = path.join(ROOT, 'native', 'winfs', 'WinfsGuard.ps1');

/**
 * 一次执行的工作区传递闭包应当**恰好**是这些包。
 *
 * 钉住整份清单而不是只钉「谁碰网络」：闭包变大意味着执行链多了一个依赖，
 * 而「多出来的那个包碰不碰网络」是必须当场重看一遍的问题。
 * 执行段自己（`@lwb/executor`）不在里面 —— 没有谁 import 它。
 */
const CLOSURE_PACKAGES: readonly string[] = [
  'approvals',
  'blob-store',
  'changes',
  'contracts',
  'egress',
  'files',
  'idempotency',
  'ipc',
  'persistence',
  'policy',
  'winfs',
];

/**
 * 闭包里唯一碰网络的包，以及**为什么**可以放它进去。
 *
 * 这份豁免是白纸黑字的：`@lwb/ipc` 里三个文件真的建立了网络端点，
 * 而执行段用的是同一个包里的租约与进程身份。放开的是**包**，钉住的是
 * **成员**（见 C2）。
 */
const NETWORK_PACKAGE_EXEMPTION = 'ipc';

/** `@lwb/ipc` 里真的碰网络的那三个文件（C1 会把它们钉死）。 */
const IPC_SOCKET_FILES: readonly string[] = ['client.ts', 'server.ts', 'single-instance.ts'];

// ---------------------------------------------------------------------------
// 检测：文本级，宁可多报
// ---------------------------------------------------------------------------

/** 网络模块的说明符。`node:` 前缀可有可无，两种写法都要拦。 */
const NETWORK_MODULES: readonly string[] = [
  'net',
  'http',
  'https',
  'tls',
  'dgram',
  'http2',
  'undici',
  'node-fetch',
  'ws',
  'axios',
  'got',
  'socket.io-client',
  'superagent',
  'request',
];

/**
 * **不需要 import 的**网络调用。
 *
 * 只看 import 会漏掉全局 `fetch` —— 它在这个仓库里从没出现过，但「从没出现
 * 过」正是这份文件要证明的，不能拿它当前提。
 */
const NETWORK_CALLS: readonly (readonly [string, RegExp])[] = [
  ['fetch(', /\bfetch\s*\(/],
  ['new WebSocket(', /\bnew\s+WebSocket\s*\(/],
  ['new XMLHttpRequest(', /\bnew\s+XMLHttpRequest\s*\(/],
  ['new EventSource(', /\bnew\s+EventSource\s*\(/],
  ['sendBeacon(', /\bsendBeacon\s*\(/],
  ['<net/http/dgram/tls>.connect|request|get(', /\b(?:https?|net|dgram|tls)\s*\.\s*(?:request|get|connect|createConnection)\s*\(/],
];

/** PowerShell 侧的网络 cmdlet 与类型。 */
const POWERSHELL_NETWORK: readonly (readonly [string, RegExp])[] = [
  ['Invoke-WebRequest', /\bInvoke-WebRequest\b/i],
  ['Invoke-RestMethod', /\bInvoke-RestMethod\b/i],
  ['Start-BitsTransfer', /\bStart-BitsTransfer\b/i],
  ['System.Net.*', /\[?\s*System\s*\.\s*Net\s*\./i],
  ['WebClient', /\bWebClient\b/i],
  ['HttpClient', /\bHttpClient\b/i],
  ['TcpClient/UdpClient', /\b(?:Tcp|Udp)Client\b/i],
  ['DownloadString/DownloadFile', /\bDownload(?:String|File|Data)\b/i],
  ['curl / wget', /(?<![\w-])(?:curl|wget)\b/i],
];

/**
 * 源码里出现的**所有**模块说明符（静态导入、`import type`、`import()`、
 * `require()`，以及 `import('node:net').Socket` 这种内联类型写法）。
 *
 * 内联那一种必须收：`packages/ipc/src/server.ts` 正是用它写的，而它同样
 * 会让 `node:net` 进到模块图里。
 */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|[^\w$.])(?:import|require|from)\s*\(?\s*['"]([^'"]+)['"]/gm;
  for (const match of text.matchAll(pattern)) out.push(match[1] ?? '');
  return out;
}

/** 说明符是不是一个网络模块。 */
function isNetworkSpecifier(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NETWORK_MODULES.includes(bare);
}

/** 一段源码里的网络导入说明符（去重、排序）。 */
function networkImports(text: string): string[] {
  return [...new Set(importSpecifiers(text).filter(isNetworkSpecifier))].sort();
}

/** 一段源码里的网络调用点（`说明符 → 命中片段`）。 */
function networkCalls(
  text: string,
  patterns: readonly (readonly [string, RegExp])[] = NETWORK_CALLS,
): string[] {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

/** 两样合起来：这一段源码碰没碰网络。 */
function networkHits(text: string): string[] {
  return [...networkImports(text).map((s) => `import ${s}`), ...networkCalls(text)];
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

async function filesUnder(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function sourcesOf(dirs: readonly string[]): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const file of await filesUnder(dir, '.ts')) {
      out.push({ file: path.relative(ROOT, file), text: await readFile(file, 'utf8') });
    }
  }
  return out;
}

/**
 * 一个工作区包的源码目录。`@lwb/ipc` 这类说明符按名字找。
 *
 * 只在 `packages/` 与 `native/` 下找：包**不许**反向依赖 `apps/` 里的宿主，
 * 因此闭包里一旦出现某个 app，就该在这里炸掉，而不是被安静地扫过去。
 * 找不到同样炸 —— 一个解析不出来的包名会让闭包看起来「干净」，
 * 而那是这份文件最不能接受的一种绿。
 */
function packageDir(name: string): string {
  for (const layer of ['packages', 'native']) {
    const candidate = path.join(ROOT, layer, name, 'src');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`闭包里出现了 @lwb/${name}，但 packages/ 与 native/ 下都没有它的源码目录`);
}

/**
 * 从执行段出发，把 `@lwb/*` 的导入边一路走到底。
 *
 * 走的是**源码里的导入边**，不是 `package.json` 的 dependencies ——
 * 后者会因为一个声明了却没人用的依赖把闭包撑大，而这里要的是「谁真的会被
 * 加载」。
 */
async function workspaceClosure(
  roots: readonly string[],
): Promise<Map<string, { file: string; text: string }[]>> {
  const closure = new Map<string, { file: string; text: string }[]>();
  const queue: string[] = [];
  for (const source of await sourcesOf(roots)) {
    for (const specifier of importSpecifiers(source.text)) {
      if (specifier.startsWith('@lwb/')) queue.push(specifier.split('/')[1] ?? '');
    }
  }

  while (queue.length > 0) {
    const name = queue.pop() ?? '';
    if (name === '' || closure.has(name)) continue;
    const sources = await sourcesOf([packageDir(name)]);
    closure.set(name, sources);
    for (const source of sources) {
      for (const specifier of importSpecifiers(source.text)) {
        if (specifier.startsWith('@lwb/')) queue.push(specifier.split('/')[1] ?? '');
      }
    }
  }
  return closure;
}

/** 一段源码**导出的**名字（含 `export { a as b }` 里的 `b`）。 */
function exportedNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /^[ \t]*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1] ?? '');
  }
  for (const match of text.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of (match[1] ?? '').split(',')) {
      const alias = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (alias !== undefined && alias !== '') names.add(alias);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// A. 直接边
// ---------------------------------------------------------------------------

describe('LWB-033 A. 直接边：执行段自己的源码里没有网络调用点', () => {
  it('A1 七棵源码树里没有一个文件碰网络', async () => {
    const sources = await sourcesOf(EXECUTION_ROOTS);
    // 先确认真的扫到了东西：空目录会让下面这条断言凭空洞地通过。
    assert.ok(sources.length >= 30, `只扫到 ${String(sources.length)} 个文件，装置本身可疑`);

    const offenders = sources
      .map((source) => ({ file: source.file, hits: networkHits(source.text) }))
      .filter((entry) => entry.hits.length > 0);
    assert.deepEqual(
      offenders.map((entry) => `${entry.file}（${entry.hits.join('、')}）`),
      [],
      '执行段里出现了网络调用点',
    );
  });

  it('A2 检测函数对合成样本的判据与它对真源码的判据是同一条', async () => {
    // 这一组与 B 组的分工：B 组拿真文件验「报得出来」，这一组把**边界**逐条
    // 钉住 —— 尤其是那些只差一个词边界就该放过的写法。
    const positives = [
      "import { connect, type Socket } from 'node:net';",
      "import { createServer, type Server } from 'node:net';",
      "import type { AddressInfo } from 'node:net';",
      "import { request } from 'node:https';",
      "import net from 'net';",
      "const m = await import('node:http');",
      "const ws = require('ws');",
      "import axios from 'axios';",
      "import got from 'got';",
      // 内联类型写法：不经过 import 语句，但同样把模块带进图里。
      "readonly onConnection: (socket: import('node:net').Socket) => void;",
    ];
    for (const sample of positives) {
      assert.notDeepEqual(networkImports(sample), [], `漏检：${sample}`);
    }
    // 每一个样式各配一句该命中的样本，并且**逐条对齐**：漏配一条就等于
    // 那条判据没人验过，而它仍然躺在扫描用的表里对真源码生效。
    const callSamples: readonly (readonly [string, string])[] = [
      ['fetch(', 'const r = await fetch(url);'],
      ['new WebSocket(', 'const s = new WebSocket(endpoint);'],
      ['new XMLHttpRequest(', 'const x = new XMLHttpRequest();'],
      ['new EventSource(', 'const e = new EventSource("/events");'],
      ['sendBeacon(', 'navigator.sendBeacon(url, body);'],
      ['<net/http/dgram/tls>.connect|request|get(', 'const req = https.request(options);'],
    ];
    assert.deepEqual(
      callSamples.map(([label]) => label),
      NETWORK_CALLS.map(([label]) => label),
      '有样式没有配自查样本（或配了多余的）—— 扫描表与自查表必须一一对应',
    );
    for (const [label, sample] of callSamples) {
      assert.ok(networkCalls(sample).includes(label), `漏检（${label}）：${sample}`);
    }

    const negatives = [
      "import { readFile } from 'node:fs/promises';",
      "import { randomUUID } from 'node:crypto';",
      "import { createServer } from '@lwb/ipc';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "import { spawn } from 'node:child_process';",
      // 变量名里带 http、说明符却是磁盘：不按变量名判。
      "const http = await import('node:fs/promises');",
      // 注释里的 URL 是**文字**，不是调用点。
      '/** 出站闸门见 https://example.com/spec */',
      // 词边界：这两个都不该被算作 `fetch(`。
      'const rows = fetchRows();',
      'if (refetched) { retry(); }',
      'const res = await fs.readFile(p);',
    ];
    for (const sample of negatives) {
      assert.deepEqual(networkHits(sample), [], `误报：${sample}`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 反向探针：真文件
// ---------------------------------------------------------------------------

describe('LWB-033 B. 反向探针：真的建立了网络端点的那些文件必须被报出来', () => {
  /** 真文件、真导入。三处本地端点 + 一处类型引用。 */
  const ANCHORS: readonly string[] = [
    'packages/ipc/src/client.ts',
    'packages/ipc/src/single-instance.ts',
    'packages/ipc/src/server.ts',
    'apps/daemon/src/runtime/ipc-server.ts',
    'apps/daemon/src/control/server.ts',
  ];

  it('B1 五个锚点文件都命中 `node:net`', async () => {
    // 比的是**说明符**而不是裸模块名：`networkImports` 交回来的就是源码里写的
    // 那一个，报错时可以原样印出来，不必让读的人自己补前缀。
    for (const rel of ANCHORS) {
      const text = await readFile(path.join(ROOT, ...rel.split('/')), 'utf8');
      assert.ok(
        networkImports(text).includes('node:net'),
        `${rel} 明明导入了 node:net，检测函数却没报出来 —— A 组因此不可信`,
      );
    }
  });

  it('B2 其中**真的**建过连接的三个文件里，写的是 `connect` / `createServer`', async () => {
    // 光有导入说明不了有人在用。这一条把「真的建端点」这件事钉在调用点上。
    const client = await readFile(path.join(ROOT, 'packages/ipc/src/client.ts'), 'utf8');
    const single = await readFile(path.join(ROOT, 'packages/ipc/src/single-instance.ts'), 'utf8');
    assert.match(client, /\bconnect\s*\(/, 'client.ts 里没有连接的调用点');
    assert.match(single, /\bcreateServer\s*\(/, 'single-instance.ts 里没有建服务器的调用点');

    // 而类型那一处（`control/server.ts`）故意只写 `import type`：它不建立
    // 任何东西。探针验的是**检测函数**，不是这几行代码的性质 —— 把这句
    // 话写下来，免得后来的人从这一组里读出「这里有五个网络端点」。
    const control = await readFile(path.join(ROOT, 'apps/daemon/src/control/server.ts'), 'utf8');
    assert.match(control, /import\s+type\s*\{[^}]*\}\s*from\s*'node:net'/);
  });
});

// ---------------------------------------------------------------------------
// C. 传递边：闭包里唯一的豁免
// ---------------------------------------------------------------------------

describe('LWB-033 C. 传递边：闭包里只有 `@lwb/ipc` 碰网络，而它只被加载', () => {
  it('C1 执行段的传递闭包恰好是这 11 个包，其中碰网络的只有 `ipc`', async () => {
    const closure = await workspaceClosure(EXECUTION_ROOTS);

    assert.deepEqual(
      [...closure.keys()].sort(),
      CLOSURE_PACKAGES,
      '执行段的传递闭包变了：多出来的包碰不碰网络，需要当场重看一遍',
    );

    const withNetwork = [...closure.entries()]
      .map(([name, sources]) => ({
        name,
        files: sources
          .filter((source) => networkHits(source.text).length > 0)
          .map((source) => path.basename(source.file))
          .sort(),
      }))
      .filter((entry) => entry.files.length > 0);

    assert.deepEqual(
      withNetwork.map((entry) => `${entry.name}（${entry.files.join('、')}）`),
      [`${NETWORK_PACKAGE_EXEMPTION}（${[...IPC_SOCKET_FILES].sort().join('、')}）`],
      '闭包里的网络导入分布与记录在案的那一份不一致',
    );
  });

  it('C2 执行段从 `@lwb/ipc` 取的名字，与那三个连接文件的导出**不相交**', async () => {
    // 这个包被放行是因为它的 barrel 把租约与进程身份一起转出，而执行段只要
    // 后者。因此判据不是「包干净」，而是「取的东西不来自那三个文件」。
    const exported = new Set<string>();
    for (const name of IPC_SOCKET_FILES) {
      const text = await readFile(path.join(ROOT, 'packages', 'ipc', 'src', name), 'utf8');
      const names = exportedNames(text);
      // 自查：导出名解析器要是恒空，下面那条不相交断言就是空话。
      assert.ok(names.length >= 2, `${name} 只解析出 ${String(names.length)} 个导出名，解析器本身可疑`);
      for (const exportedName of names) exported.add(exportedName);
    }

    const used = new Map<string, string[]>();
    for (const source of await sourcesOf(EXECUTION_ROOTS)) {
      for (const match of source.text.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@lwb\/ipc['"]/g,
      )) {
        const names = (match[1] ?? '')
          .split(',')
          .map((part) =>
            part
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '',
          )
          .filter((name) => name !== '');
        if (names.length > 0) used.set(source.file, names);
      }
    }

    // 又是自查：取用清单为空时，不相交也是空话。
    assert.ok(used.size >= 3, `只找到 ${String(used.size)} 处对 @lwb/ipc 的取用，装置本身可疑`);

    const collisions: string[] = [];
    for (const [file, names] of used) {
      for (const name of names) {
        if (exported.has(name)) collisions.push(`${file} 取用了 ${name}`);
      }
    }
    assert.deepEqual(collisions, [], '执行段从 @lwb/ipc 取到了连接文件里的东西');
  });

  it('C3 那个包自己**不**是执行链的一环 —— 执行段里没有一行发起连接', async () => {
    // 「只被加载」这句话的判据：执行段里出现的 `@lwb/ipc` 成员不能是
    // 任何与 socket 有关的东西，而且执行段自己的源码里没有连接调用点。
    // （A1 已经查过后者；这里把**取用的名字**再钉一遍，因为一个
    //  `const { attachSocket } = ipc` 形式的取用不会出现在 import 语句里。）
    const sources = await sourcesOf(EXECUTION_ROOTS);
    for (const source of sources) {
      for (const match of source.text.matchAll(/\b(attachSocket|IpcClient|acquireSingleInstance)\b/g)) {
        assert.fail(`${source.file} 提到了 ${match[1]} —— 执行段不该碰到连接那一层`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D. 护栏助手那一半
// ---------------------------------------------------------------------------

describe('LWB-033 D. 护栏助手脚本里没有网络 cmdlet', () => {
  it('D1 `WinfsGuard.ps1` 一处都不碰', async () => {
    const text = await readFile(GUARD_HELPER, 'utf8');
    assert.ok(text.length > 10_000, `只读到 ${String(text.length)} 个字符，脚本本身可疑`);
    assert.deepEqual(networkCalls(text, POWERSHELL_NETWORK), [], '护栏助手脚本里出现了网络调用');
  });

  it('D2 同一条判据用在真的会联网的 PowerShell 上必须报出来', () => {
    const positives: readonly (readonly [string, string])[] = [
      ['Invoke-WebRequest', 'Invoke-WebRequest -Uri $u'],
      ['Invoke-RestMethod', 'Invoke-RestMethod -Uri $u -Method Post'],
      ['Start-BitsTransfer', 'Start-BitsTransfer -Source $u'],
      ['System.Net.*', '$c = [System.Net.WebClient]::new()'],
      ['WebClient', '$c = New-Object System.Net.WebClient'],
      ['HttpClient', '$h = [System.Net.Http.HttpClient]::new()'],
      ['TcpClient/UdpClient', '$t = [System.Net.Sockets.TcpClient]::new($h, $p)'],
      ['DownloadString/DownloadFile', '$s = $c.DownloadString($u)'],
      ['curl / wget', 'curl.exe -s $u'],
    ];
    assert.deepEqual(
      positives.map(([label]) => label),
      POWERSHELL_NETWORK.map(([label]) => label),
      '有样式没有配自查样本（或配了多余的）',
    );
    for (const [label, sample] of positives) {
      assert.ok(
        networkCalls(sample, POWERSHELL_NETWORK).includes(label),
        `漏检（${label}）：${sample}`,
      );
    }

    const negatives = [
      // 护栏真的用的就是这一族：P/Invoke 与 Win32，不是网络。
      '$r = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
      '[System.IO.File]::Open($p, $mode, $access, $share)',
      '$h = [System.IO.FileStream]::new($p, $mode, $access, $share)',
      'Add-Type -Namespace Lwb -Name PInvoke -MemberDefinition $code',
      // 变量名里带 net/response：不按变量名判。
      '$netBytes = 0',
      '$response = $null',
      '# 见 docs/evidence/g4-write.md',
    ];
    for (const sample of negatives) {
      assert.deepEqual(networkCalls(sample, POWERSHELL_NETWORK), [], `误报：${sample}`);
    }
  });
});
