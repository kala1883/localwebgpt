#!/usr/bin/env node
/**
 * 静态导入检查（LWB-005 验收：仓库静态检查能发现绕过 FsGuard 的导入）。
 *
 * 目的：防止后续开发「顺手」在业务包里直接 import 可写 fs 或 child_process，
 * 从而绕过统一的 FsGuard 与策略层。这不是风格检查，是安全边界检查。
 *
 * 使用 TypeScript 编译器解析 AST，而不是正则：
 * 正则无法可靠区分注释、字符串与真实 import，也无法覆盖动态 import()。
 *
 * ## .vue 单文件组件（LWB-023 起）
 *
 * 检查范围原本只有 `.ts`，于是 `apps/console/views/*.vue` 这一类文件对
 * 本检查**完全不可见** —— 它既不「被允许」，也不「被检查」。这不是理论
 * 问题：控制台渲染的正是模型提议的内容，`import fs from 'node:fs'`
 * 写在 `<script setup>` 里会一路通过。
 *
 * 现在 `.vue` 也会被收集：把 `<script>` 块**之外**的内容（模板、样式、
 * 标签本身）整段替换成空白，只留脚本正文交给 AST 解析器。替换是
 * **逐字符**的且保留换行，因此报出来的行号与源文件一致 —— 一个报错
 * 行号偏移的检查会让人花更多时间怀疑检查本身。
 *
 * 用法：node scripts/check-fsguard-imports.mjs [--json]
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonOutput = process.argv.includes('--json');

/** 禁止在业务层直接导入的模块。 */
const FORBIDDEN_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'node:module', // createRequire 可绕过本检查
]);

/**
 * 允许直接使用上述模块的路径前缀。
 * 这些包本身就是文件系统/进程边界的实现者，它们必须把能力收敛成
 * FsGuard / BlobStore / Ipc 接口，供业务层使用。
 *
 * 注意规则 1 的条件是 `isBusiness && !isAllowed`，因此**两个列表都不在**的包
 * 会被静默跳过：它既不「被允许」，也不「被检查」。新增一个包时必须把它写进
 * 其中一个列表 —— 业务包（BUSINESS）只写 BUSINESS，能直接碰文件系统的
 * 边界实现者（ALLOWED）写进 ALLOWED。写错方向的后果是单向的：
 * 把一个业务包写进 ALLOWED，等于永久放行它直接 import fs。
 */
const ALLOWED_PREFIXES = [
  'native/',
  'packages/persistence/',
  'packages/secure-store/',
  'packages/blob-store/',
  'packages/ipc/',
  'apps/daemon/src/lifecycle/',
  'apps/mcp-adapter/src/stdio/',
  'scripts/',
  'tests/',
];

/** 业务包：这些包只允许通过受控接口访问文件系统。 */
const BUSINESS_PREFIXES = [
  'packages/contracts/',
  'packages/workspaces/',
  'packages/policy/',
  'packages/egress/',
  'packages/files/',
  'packages/search/',
  'packages/git-reader/',
  'packages/changes/',
  'packages/approvals/',
  'packages/executor/',
  'packages/recovery/',
  'packages/audit/',
  'packages/limits/',
  'packages/idempotency/',
  // 控制台整体是业务层（LWB-023 起）。原先写的是 `apps/console/src/`，
  // 而页面在 `apps/console/views/` 与 `apps/console/components/` ——
  // 那两处的 `.vue` 因此落在两个列表之外，被规则 1 静默跳过。
  // 放宽到整个 `apps/console/`：控制台只能通过 `@lwb/ipc` 的
  // `ControlClient` 访问本机，没有任何一处需要直接碰文件系统。
  'apps/console/',
  // 守护进程整体是业务层（LWB-025 装配根起）。原先写的是 `control/` 与
  // `tools/` 两个子目录，而 `apps/daemon/src/gates.ts`（直接位于 `src/` 下）
  // 与新增的 `apps/daemon/src/runtime/` 因此落在两个列表之外，被规则 1
  // 静默跳过 —— 既不「被允许」，也不「被检查」。放宽到整个 `apps/daemon/src/`：
  // 装配根本身只经由 `@lwb/secure-store` / `@lwb/persistence` / `@lwb/ipc`
  // 访问本机，唯一需要直接碰进程与文件系统的 `lifecycle/` 写在 ALLOWED 里，
  // 两个列表都出现的路径按「被允许」处理。
  'apps/daemon/src/',
  // 适配器整体是业务层：它只能通过 `@lwb/ipc` 访问本机。唯一的例外是
  // `apps/mcp-adapter/src/stdio/`（见 ALLOWED_PREFIXES）—— 那是 stdio 边界本身，
  // 它必须能碰进程的标准输入输出。两个列表都出现的路径按「被允许」处理，
  // 规则 1 的条件是 `isBusiness && !isAllowed`，因此这个缺口是**局部**的：
  // 适配器的其余部分仍然受检。
  'apps/mcp-adapter/src/',
];

/** contracts 只允许这些依赖，保证它是纯契约。 */
const CONTRACTS_ALLOWED_MODULES = new Set(['zod', 'node:crypto', 'crypto']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'generated', 'coverage', 'winfs-spike']);

/**
 * 一个 SFC 里所有 `<script>` 块的正文区间（`[start, end)`，相对整份文件）。
 *
 * 用非贪婪匹配取 `<script ...>` 与最近的 `</script>` 之间那一段。一个
 * `.vue` 文件最多有一个 `<script>` 加一个 `<script setup>`，两者都会被取到。
 */
function scriptRegions(text) {
  const regions = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const openEnd = match.index + match[0].indexOf('>') + 1;
    regions.push([openEnd, openEnd + match[1].length]);
  }
  return regions;
}

/**
 * 把 `<script>` 块之外的内容换成空白，**逐字符替换并保留换行**。
 *
 * 保留换行是为了让行号仍然对得上：解析器数的是换行，只要换行数不变，
 * 报出来的行号就与源文件一致。若整段删掉，`.vue` 里报的行号会偏到
 * 模板之前，而一个行号不准的检查会让人先怀疑检查本身。
 *
 * 换掉而不是删掉的另一个理由：模板里可能写着 `import` 这个词（例如
 * 一段说明文字）。留着它会让正则式的检查产生假阳性 —— 这里虽然走 AST，
 * 但把无关内容从解析输入里彻底拿掉，比指望解析器不误会更可靠。
 */
function maskOutsideScripts(text, regions) {
  const blank = (slice) => slice.replace(/[^\n\r]/g, ' ');
  let out = '';
  let cursor = 0;
  for (const [start, end] of regions) {
    out += blank(text.slice(cursor, start));
    out += text.slice(start, end);
    cursor = end;
  }
  return out + blank(text.slice(cursor));
}

/** 本检查解析的文件类型。`.vue` 只解析其脚本块，见 `maskOutsideScripts`。 */
function isCheckedFile(name) {
  if (name.endsWith('.d.ts')) return false;
  return name.endsWith('.ts') || name.endsWith('.vue');
}

async function collect(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(full, out);
    } else if (entry.isFile() && isCheckedFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(relativePath) {
  return ALLOWED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isBusiness(relativePath) {
  return BUSINESS_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

/** 从 AST 中提取所有 import / export-from / 动态 import / require 的模块说明符。 */
function extractModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push({ value: node.moduleSpecifier.text, pos: node.moduleSpecifier.getStart(sourceFile) });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({ value: node.moduleSpecifier.text, pos: node.moduleSpecifier.getStart(sourceFile) });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ value: node.arguments[0].text, pos: node.arguments[0].getStart(sourceFile) });
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push({ value: node.arguments[0].text, pos: node.arguments[0].getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

const roots = ['packages', 'apps', 'native'];
const files = [];
for (const root of roots) {
  const abs = path.resolve(repoRoot, root);
  if (existsSync(abs)) await collect(abs, files);
}

const violations = [];

for (const file of files) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const text = await readFile(file, 'utf8');
  // `.vue` 只把 `<script>` 块交给解析器，其余位置换成空白（行号不变）。
  const parseText = file.endsWith('.vue') ? maskOutsideScripts(text, scriptRegions(text)) : text;
  const sourceFile = ts.createSourceFile(file, parseText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const specifiers = extractModuleSpecifiers(sourceFile);

  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  for (const spec of specifiers) {
    // 规则 1：业务层禁止直接导入可写 fs / child_process。
    if (FORBIDDEN_MODULES.has(spec.value) && isBusiness(relative) && !isAllowed(relative)) {
      violations.push({
        rule: 'FSGUARD_BYPASS',
        file: relative,
        line: lineOf(spec.pos),
        module: spec.value,
        message:
          '业务包不得直接导入文件系统/进程模块；必须通过 FsGuard、BlobStore 或受控接口访问。',
      });
    }

    // 规则 2：contracts 必须是纯契约。
    if (relative.startsWith('packages/contracts/')) {
      const isRelativeImport = spec.value.startsWith('.');
      if (!isRelativeImport && !CONTRACTS_ALLOWED_MODULES.has(spec.value)) {
        violations.push({
          rule: 'CONTRACTS_IMPURITY',
          file: relative,
          line: lineOf(spec.pos),
          module: spec.value,
          message: `contracts 只允许依赖 ${[...CONTRACTS_ALLOWED_MODULES].join(' / ')}。`,
        });
      }
    }
  }
}

if (jsonOutput) {
  console.log(JSON.stringify({ checked: files.length, violations }, null, 2));
} else if (violations.length === 0) {
  console.log(`✅ FsGuard 导入检查通过（已检查 ${files.length} 个文件，未发现绕过）。`);
} else {
  console.error(`❌ FsGuard 导入检查发现 ${violations.length} 处违规：\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}`);
    console.error(`      导入 "${v.module}"`);
    console.error(`      ${v.message}\n`);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
