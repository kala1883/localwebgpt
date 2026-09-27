/**
 * 相对路径**语法**校验的单元测试。
 *
 * 对应：LWB-010 步骤 1、方案 §5.2、验收矩阵 A11 的语法部分。
 *
 * 注意边界：这些用例只证明「混淆性输入在解析前被拒绝」。
 * 真正的安全判定（逐级句柄固定、reparse 检测、文件身份比对）必须由
 * native/winfs 的实机证据证明，不能用本文件的结果冒充。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SEGMENT_CHARS,
  validateRelativePath,
  type PathRejectReason,
} from '@lwb/contracts';

function expectReject(input: unknown, reason: PathRejectReason): void {
  const result = validateRelativePath(input);
  assert.equal(result.ok, false, `期望 ${JSON.stringify(input)} 被拒绝，但被接受`);
  if (result.ok) return;
  assert.equal(
    result.reason,
    reason,
    `${JSON.stringify(input)} 拒绝原因应为 ${reason}，实际是 ${result.reason}（${result.detail}）`,
  );
}

function expectAccept(input: string, expectedNormalized: string): void {
  const result = validateRelativePath(input);
  assert.equal(result.ok, true, `期望 ${JSON.stringify(input)} 被接受，但被拒绝`);
  if (!result.ok) return;
  assert.equal(result.normalized, expectedNormalized);
}

describe('validateRelativePath / 拒绝用例（LWB-010）', () => {
  it('拒绝非字符串与空路径', () => {
    expectReject(undefined, 'NOT_A_STRING');
    expectReject(null, 'NOT_A_STRING');
    expectReject(42, 'NOT_A_STRING');
    expectReject({}, 'NOT_A_STRING');
    expectReject('', 'EMPTY');
    expectReject('   ', 'EMPTY');
  });

  it('拒绝绝对路径与根相对路径', () => {
    expectReject('/etc/passwd', 'ABSOLUTE');
    expectReject('\\Windows\\System32', 'ABSOLUTE');
    expectReject('/a/b', 'ABSOLUTE');
  });

  it('拒绝 UNC 路径', () => {
    expectReject('\\\\server\\share\\file.txt', 'UNC');
    expectReject('//server/share/file.txt', 'UNC');
  });

  it('拒绝设备命名空间路径', () => {
    expectReject('\\\\?\\C:\\Windows\\system.ini', 'DEVICE_NAMESPACE');
    expectReject('\\\\.\\PhysicalDrive0', 'DEVICE_NAMESPACE');
    expectReject('\\??\\C:\\Windows', 'DEVICE_NAMESPACE');
  });

  it('拒绝盘符形式（含相对盘符）', () => {
    expectReject('C:\\Windows\\win.ini', 'DRIVE_LETTER');
    expectReject('C:Windows', 'DRIVE_LETTER');
    expectReject('d:/x.txt', 'DRIVE_LETTER');
  });

  it('拒绝 ADS（备用数据流）与任何冒号', () => {
    expectReject('file.txt:stream', 'ADS_COLON');
    expectReject('dir/file.txt:$DATA', 'ADS_COLON');
    expectReject('a/b:c', 'ADS_COLON');
  });

  it('拒绝上级引用与点段', () => {
    expectReject('..', 'PARENT_REF');
    expectReject('../secret.txt', 'PARENT_REF');
    expectReject('a/../../b', 'PARENT_REF');
    expectReject('a\\..\\b', 'PARENT_REF');
    expectReject('a/./b', 'DOT_SEGMENT');
  });

  it('拒绝控制字符与 NUL', () => {
    expectReject('a\u0000b', 'CONTROL_CHAR');
    expectReject('a\nb', 'CONTROL_CHAR');
    expectReject('a\tb', 'CONTROL_CHAR');
    expectReject('a\u007fb', 'CONTROL_CHAR');
  });

  it('拒绝 Windows 非法字符', () => {
    expectReject('a<b', 'INVALID_CHAR');
    expectReject('a>b', 'INVALID_CHAR');
    expectReject('a|b', 'INVALID_CHAR');
    expectReject('a?b', 'INVALID_CHAR');
    expectReject('a*b', 'INVALID_CHAR');
    expectReject('a"b', 'INVALID_CHAR');
  });

  it('拒绝空段与结尾分隔符', () => {
    expectReject('a//b', 'EMPTY_SEGMENT');
    expectReject('a/', 'TRAILING_SEPARATOR');
    expectReject('a\\', 'TRAILING_SEPARATOR');
  });

  it('拒绝以点或空格结尾的路径段', () => {
    expectReject('a./b', 'TRAILING_DOT_OR_SPACE');
    expectReject('a /b', 'TRAILING_DOT_OR_SPACE');
    expectReject('docs/readme.md.', 'TRAILING_DOT_OR_SPACE');
    // Windows 对结尾空格与点做剥离，"file " 会打开 "file"，
    // 这正是必须拒绝的原因（表面路径与实际对象不一致）。
    expectReject('dir/name ', 'TRAILING_DOT_OR_SPACE');
  });

  it('拒绝 Windows 保留设备名（含带扩展名形式）', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CONIN$', 'CONOUT$']) {
      expectReject(name, 'RESERVED_NAME');
      expectReject(`docs/${name}`, 'RESERVED_NAME');
    }
    // 带扩展名仍然保留。
    expectReject('CON.txt', 'RESERVED_NAME');
    expectReject('dir/nul.md', 'RESERVED_NAME');
  });

  it('拒绝超长路径、超长段与过深路径', () => {
    expectReject('a'.repeat(1025), 'TOO_LONG');
    expectReject(`${'a'.repeat(MAX_SEGMENT_CHARS + 1)}/b.txt`, 'SEGMENT_TOO_LONG');
    expectReject(Array.from({ length: 70 }, () => 'd').join('/'), 'TOO_DEEP');
  });
});

describe('validateRelativePath / 接受用例', () => {
  it('接受普通 ASCII 路径并统一分隔符', () => {
    expectAccept('src/index.ts', 'src/index.ts');
    expectAccept('src\\index.ts', 'src/index.ts');
    expectAccept('a/b/c/d.txt', 'a/b/c/d.txt');
  });

  it('接受中文路径与 emoji（LWB-001 夹具要求）', () => {
    expectAccept('文档/设计说明.md', '文档/设计说明.md');
    expectAccept('资料/2026年方案/📄笔记.txt', '资料/2026年方案/📄笔记.txt');
  });

  it('接受含 ~ 的名称：8.3 别名必须由文件身份消歧，而不是靠字符串判断', () => {
    expectAccept('a~1/b~2.txt', 'a~1/b~2.txt');
    expectAccept('report~$/x.md', 'report~$/x.md');
  });

  it('接受点号开头的隐藏文件', () => {
    expectAccept('.gitignore', '.gitignore');
    expectAccept('config/.env.example', 'config/.env.example');
  });

  it('接受恰好达到上限的段长与深度', () => {
    expectAccept('a'.repeat(MAX_SEGMENT_CHARS), 'a'.repeat(MAX_SEGMENT_CHARS));
    expectAccept(Array.from({ length: 64 }, (_, i) => `d${i}`).join('/'), Array.from({ length: 64 }, (_, i) => `d${i}`).join('/'));
  });

  it('大小写保持原样（Windows 比较另行处理）', () => {
    expectAccept('Src/Index.TS', 'Src/Index.TS');
  });
});
