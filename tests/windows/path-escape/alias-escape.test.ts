/**
 * 别名逃逸（LWB-010 步骤 2/3/4）。
 *
 * 「别名」指的是**同一个物理对象的多个名字**：
 *   大小写、8.3 短名、硬链接、Junction / 符号链接、备用数据流（ADS）。
 *
 * 它们为什么是同一类问题：基于**路径字符串**的策略比对会把它们
 * 当成不同的东西（或把不同的东西当成同一个），而磁盘上的对象是同一个。
 * 护栏的处置方式不是"把别名枚举出来拉黑"（那永远列不全），
 * 而是**按打开后的对象身份判定** —— 名字怎么变，`volume_id` / `file_id` 不变。
 *
 * 因此这些用例断言的是：
 *   1. 别名能被打开时，拿到的身份与正名**完全一致**（说明判定依据是对象，不是字符串）；
 *   2. 别名指向工作区外时，打开被拒绝；
 *   3. 回执里给出的是**磁盘拼写**，不是调用方请求里那个字符串。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PowerShellWinfsBackend, isWinfsError } from '@lwb/winfs';

import { describeWindows, expectRejected, ps, readOk, refFor, type RootRef } from './helpers.ts';

describeWindows('LWB-010 别名逃逸', () => {
  let backend: PowerShellWinfsBackend;
  let sandbox: string;
  /** 工作区根。别名逃逸的用例都把工作区做成沙箱的一个子目录。 */
  let ws: string;
  let wsRef: RootRef;

  before(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'lwb-alias-'));
    ws = path.join(sandbox, 'ws');
    await mkdir(ws, { recursive: true });
    backend = new PowerShellWinfsBackend();
    const capability = await backend.capability();
    assert.equal(capability.available, true, `护栏不可用：${capability.resolved_backend_reason}`);
    wsRef = await refFor(backend, ws);
  });

  after(async () => {
    await backend?.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 大小写别名
  // -----------------------------------------------------------------------
  describe('大小写别名', () => {
    it('大小写不同的写法指向同一个对象，身份完全一致', async () => {
      const content = Buffer.from('case alias 内容\n', 'utf8');
      await writeFile(path.join(ws, 'Alpha.txt'), content);

      const exact = await readOk(backend, { ...wsRef, relative_path: 'Alpha.txt' });
      const lower = await readOk(backend, { ...wsRef, relative_path: 'alpha.txt' });
      const upper = await readOk(backend, { ...wsRef, relative_path: 'ALPHA.TXT' });

      assert.equal(lower.file_id, exact.file_id, '大小写不同不应改变对象身份');
      assert.equal(upper.file_id, exact.file_id, '大小写不同不应改变对象身份');
      assert.equal(lower.sha256, exact.sha256);
      assert.equal(lower.size, content.length);
    });

    it('回执给出磁盘拼写，而不是请求里写的那个字符串', async () => {
      // 这一条不是吹毛求疵：回执的用途是让人能拿去和文件系统核对（I14）。
      // 若回执写 "ALPHA.TXT" 而磁盘上是 "Alpha.txt"，核对的人会得出
      // 「这个文件不存在」的结论 —— 一份核不动的回执等于没有回执。
      const exact = await readOk(backend, { ...wsRef, relative_path: 'Alpha.txt' });
      const upper = await readOk(backend, { ...wsRef, relative_path: 'ALPHA.TXT' });

      assert.equal(exact.canonical_relative_path, 'Alpha.txt');
      assert.equal(
        upper.canonical_relative_path,
        'Alpha.txt',
        '用 ALPHA.TXT 请求时，规范路径仍应是磁盘上的拼写',
      );
    });

    it('目录列举里的条目路径同样用磁盘拼写', async () => {
      await mkdir(path.join(ws, 'MixedCase'), { recursive: true });
      await writeFile(path.join(ws, 'MixedCase', 'Inner.txt'), 'x', 'utf8');

      const listed = await backend.listDirectory({ ...wsRef, relative_path: 'mixedcase' });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      if (listed.ok !== true || isWinfsError(listed)) return;

      assert.equal(listed.canonical_relative_path, 'MixedCase');
      const inner = listed.entries.find((e) => e.name === 'Inner.txt');
      assert.ok(inner, `条目里应有 Inner.txt：${JSON.stringify(listed.entries.map((e) => e.name))}`);
      assert.equal(
        inner.relative_path,
        'MixedCase/Inner.txt',
        '条目路径必须以磁盘拼写为前缀，否则调用方拿着它去下一层会打不开',
      );
      // 而且这个路径必须真的能用。
      const viaEntry = await readOk(backend, { ...wsRef, relative_path: inner.relative_path });
      assert.equal(viaEntry.size, 1);
    });
  });

  // -----------------------------------------------------------------------
  // 8.3 短名
  // -----------------------------------------------------------------------
  describe('8.3 短名', () => {
    // 这条与「大小写别名」的结果**不同**，而这个不同是刻意的。
    //
    // 大小写：内核返回的规范路径与请求只差大小写，比较键大小写不敏感，因此**接受**。
    // 8.3 短名：内核返回的规范路径是**长名**，与请求不是同一串字符，因此**拒绝**。
    //
    // 为什么不做成"接受并回报长名"：接受意味着「同一个对象有很多个我们都认的名字」，
    // 于是"路径 → 对象"的映射变得更加多对一。本系统里没有任何一处会生成 8.3 短名，
    // 因此拒绝它不会挡住任何正当用法，却少了一整类需要解释的等价关系。
    // 这是 I10（拒绝而非降级）在别名问题上的具体落法。
    it('8.3 短名被拒绝（与大小写别名不同，且这个不同是刻意的）', async (t) => {
      const longName = 'VeryLongFileNameForShortName.txt';
      await writeFile(path.join(ws, longName), 'short name 内容\n', 'utf8');

      const full = path.join(ws, longName);
      // GetShortPathNameW 的 .NET 包装不在 Core 里（FileSystemInfo.ShortName 已移除），
      // 因此直接用 Win32 API 问，而不是猜一个 "VERYLO~1.TXT"。
      const shortName = ps(
        `Add-Type -Namespace S -Name K -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathNameW(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);'; ` +
          `$sb = New-Object System.Text.StringBuilder 512; ` +
          `$n = [S.K]::GetShortPathNameW('${full.replace(/'/g, "''")}', $sb, 512); ` +
          `if ($n -eq 0) { 'NONE' } else { $sb.ToString() }`,
      );
      const leaf = shortName === 'NONE' ? '' : path.win32.basename(shortName);

      if (shortName === 'NONE' || leaf.length === 0) {
        // 该卷关闭了 8.3 名生成。这是环境事实，不是通过。
        t.diagnostic(
          `本卷未生成 8.3 短名（GetShortPathNameW 返回 0），此项 NOT_RUN。` +
            `这不是通过：短名逃逸在本环境上未被验证。`,
        );
        return;
      }
      assert.notEqual(leaf, longName, `短名应与长名不同，实际都是 ${leaf}`);

      // 正名照常可读。
      const viaLong = await readOk(backend, { ...wsRef, relative_path: longName });
      assert.equal(viaLong.canonical_relative_path, longName);

      // 短名被拒绝，且理由明确指向"句柄真实路径与预期不一致"，
      // 而不是一个含糊的 NOT_FOUND —— 后者会让人以为文件不存在。
      const err = await expectRejected(
        'PATH_UNSAFE',
        () => backend.readFileGuarded({ ...wsRef, relative_path: leaf }),
        `经 8.3 短名 ${leaf} 读取`,
      );
      assert.match(err.message, /真实路径与预期不一致/, `理由应说明规范路径不符：${err.message}`);
      assert.match(err.message, new RegExp(longName.replace(/\./g, '\\.')), `理由里应出现内核返回的长名`);
    });
  });

  // -----------------------------------------------------------------------
  // 硬链接
  // -----------------------------------------------------------------------
  describe('硬链接', () => {
    it('工作区外的文件被硬链接进来：可读，但写一律拒绝', async () => {
      const outside = path.join(sandbox, 'outside-hardlink');
      await mkdir(outside, { recursive: true });
      const secret = path.join(outside, 'secret.txt');
      await writeFile(secret, '工作区外的内容\n', 'utf8');

      const linkPath = path.join(ws, 'entry.txt');
      const made = ps(
        `New-Item -ItemType HardLink -Path '${linkPath.replace(/'/g, "''")}' -Target '${secret.replace(/'/g, "''")}' | Out-Null; 'OK'`,
      );
      assert.ok(made.includes('OK'), `创建硬链接失败：${made}`);

      // 读：允许。它**确实**是工作区内的一个对象，读到的是它自己的字节。
      const read = await readOk(backend, { ...wsRef, relative_path: 'entry.txt' });
      assert.equal(read.link_count, 2, '硬链接数应为 2');
      assert.equal(read.size, Buffer.byteLength('工作区外的内容\n', 'utf8'));

      // 写：拒绝。NTFS 的文件没有「父目录」概念，写入会同时改变
      // 工作区**外**的那个名字 —— 那不是本次授权覆盖的对象。
      const err = await expectRejected(
        'LINK_UNSUPPORTED',
        () => backend.writeFileGuarded({ ...wsRef, relative_path: 'entry.txt', expected_sha256: read.sha256, content_base64: Buffer.from('改掉它').toString('base64') }),
        '写入多重硬链接文件',
      );
      assert.match(err.message, /硬链接/, `拒绝理由应说明是硬链接：${err.message}`);

      // 而且外面那个名字的内容确实没变 —— 拒绝是有效的，不只是报了个错。
      assert.equal(
        (await readFile(secret, 'utf8')),
        '工作区外的内容\n',
        '被拒绝的写入不得改动工作区外对象',
      );
    });
  });

  // -----------------------------------------------------------------------
  // 备用数据流（ADS）
  // -----------------------------------------------------------------------
  describe('备用数据流', () => {
    it('主文件可读，而其 ADS 在语法层就被拒绝', async () => {
      const target = path.join(ws, 'with-stream.txt');
      const main = '主数据流内容\n';
      await writeFile(target, main, 'utf8');

      // 造一个隐藏流。用 cmd 的 echo 重定向，因为 .NET 的路径处理会加 \\?\ 前缀，
      // 与护栏实际使用的调用形式不一致 —— 我们要造的是"真存在的东西"。
      const made = ps(
        `cmd /c "echo hidden > \\"${target.replace(/"/g, '')}:evil\\""; ` +
          `if (Test-Path -LiteralPath '${target.replace(/'/g, "''")}' -Stream evil) { 'HAS_STREAM' } else { 'NO_STREAM' }`,
      );
      const hasStream = made.includes('HAS_STREAM');

      const read = await readOk(backend, { ...wsRef, relative_path: 'with-stream.txt' });
      assert.equal(read.size, Buffer.byteLength(main, 'utf8'), '读到的应只是主数据流');
      assert.equal(
        read.sha256,
        (await import('node:crypto')).createHash('sha256').update(Buffer.from(main, 'utf8')).digest('hex'),
        '哈希必须只覆盖主数据流 —— 否则基线里混进了调用方看不到的字节',
      );

      // 无论流有没有造出来（cmd 在受限环境里可能被策略拦住），
      // 语法层都必须拒绝含冒号的路径。
      await expectRejected(
        'PATH_UNSAFE',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'with-stream.txt:evil' }),
        '读取 ADS',
      );
      await expectRejected(
        'PATH_UNSAFE',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'with-stream.txt:$DATA' }),
        '读取显式 $DATA 流',
      );

      if (!hasStream) {
        assert.ok(
          made.length > 0,
          '构造 ADS 的命令没有输出，无法判断流是否存在',
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // 目录链接（Junction）
  // -----------------------------------------------------------------------
  describe('目录链接', () => {
    it('指向工作区外的 Junction 不可穿越，且被明确标为 reparse', async () => {
      const outside = path.join(sandbox, 'outside-junction');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'secret.txt'), '不该读到的内容\n', 'utf8');

      const junction = path.join(ws, 'escape-link');
      const made = ps(
        `New-Item -ItemType Junction -Path '${junction.replace(/'/g, "''")}' -Target '${outside.replace(/'/g, "''")}' | Out-Null; 'OK'`,
      );
      assert.ok(made.includes('OK'), `创建 Junction 失败：${made}`);

      // 1) 列举时如实标出它是重解析点，而不是把它当成普通目录。
      const listed = await backend.listDirectory({ ...wsRef, relative_path: '' });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      if (listed.ok === true && !isWinfsError(listed)) {
        const entry = listed.entries.find((e) => e.name === 'escape-link');
        assert.ok(entry, '目录列举应包含该 Junction');
        assert.equal(entry.is_reparse, true, 'Junction 必须被标为重解析点');
        assert.equal(entry.type, 'directory');
        // 不取长度：取长度会跟随链接去问外部对象的长度（泄漏工作区外信息）。
        assert.equal(entry.size, null, '重解析点不得报告目标的大小');
      }

      // 2) 穿越它去读外部文件：拒绝。
      const err = await expectRejected(
        'LINK_UNSUPPORTED',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'escape-link/secret.txt' }),
        '经 Junction 读取工作区外文件',
      );
      assert.match(err.message, /重解析点|Junction/, `理由应指出重解析点：${err.message}`);

      // 3) 把 Junction 自己当目标：同样拒绝。
      await expectRejected(
        'LINK_UNSUPPORTED',
        () => backend.listDirectory({ ...wsRef, relative_path: 'escape-link' }),
        '把 Junction 当目录列举',
      );
    });

    it('符号链接（需要开发者模式或管理员）—— 造不出来时如实标注 NOT_RUN', async (t) => {
      const outside = path.join(sandbox, 'outside-symlink');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'secret.txt'), '不该读到的内容\n', 'utf8');

      const link = path.join(ws, 'escape-symlink');
      const made = ps(
        `try { New-Item -ItemType SymbolicLink -Path '${link.replace(/'/g, "''")}' -Target '${outside.replace(/'/g, "''")}' -ErrorAction Stop | Out-Null; 'OK' } catch { "FAIL: $($_.Exception.Message)" }`,
      );
      if (!made.includes('OK')) {
        t.diagnostic(
          `本会话无权限创建符号链接（需要开发者模式或管理员），此项 NOT_RUN。` +
            `这不是通过：目录符号链接的拒绝路径在本环境上未被验证。原始输出：${made}`,
        );
        return;
      }

      await expectRejected(
        'LINK_UNSUPPORTED',
        () => backend.readFileGuarded({ ...wsRef, relative_path: 'escape-symlink/secret.txt' }),
        '经符号链接读取工作区外文件',
      );
    });
  });

  // -----------------------------------------------------------------------
  // 设备命名空间与保留名
  // -----------------------------------------------------------------------
  describe('设备命名空间与保留名', () => {
    it('设备命名空间路径在语法层被拒绝', async () => {
      for (const rel of [
        `\\\\?\\${ws}\\Alpha.txt`,
        `\\\\.\\${ws}`,
        '\\\\?\\C:\\Windows\\System32\\drivers\\etc\\hosts',
      ]) {
        const err = await expectRejected(
          'PATH_UNSAFE',
          () => backend.readFileGuarded({ ...wsRef, relative_path: rel }),
          `设备命名空间 ${rel}`,
        );
        assert.match(err.message, /DEVICE_NAMESPACE/, `理由应为 DEVICE_NAMESPACE：${err.message}`);
      }
    });

    it('保留设备名 NUL 被拒绝，而写入不会"成功但消失"', async () => {
      // 实测记录（Windows 11 26200）：
      //   CreateFileW('C:\\<dir>\\NUL', GENERIC_WRITE, CREATE_ALWAYS) -> 有效句柄, err=0
      //   WriteFile -> TRUE, 写入 33 字节, err=0
      //   磁盘上：什么都没有。
      // 若放行，createFileGuarded 会返回一份"已保存"的回执，
      // 而那个文件从未存在过 —— 直接违反 I14。
      const err = await expectRejected(
        'PATH_UNSAFE',
        () => backend.createFileGuarded({
          ...wsRef,
          relative_path: 'NUL',
          content_base64: Buffer.from('这段内容不该消失').toString('base64'),
        }),
        '在目录下创建名为 NUL 的文件',
      );
      assert.match(err.message, /RESERVED_NAME/, `理由应为 RESERVED_NAME：${err.message}`);
    });

    it('上跳与绝对路径在语法层被拒绝', async () => {
      for (const [rel, reason] of [
        ['../outside-junction/secret.txt', 'PARENT_REF'],
        ['escape-link/../Alpha.txt', 'PARENT_REF'],
        ['..', 'PARENT_REF'],
        // 工作区根的绝对路径本身也是绝对路径：模型完全可能"抄近路"把
        // root_path 和 relative_path 拼起来当相对路径传进来，必须拒。
        [`${ws}\\Alpha.txt`, 'DRIVE_LETTER'],
        ['C:\\Windows\\win.ini', 'DRIVE_LETTER'],
        ['\\\\server\\share\\f.txt', 'UNC'],
      ] as const) {
        const err = await expectRejected(
          'PATH_UNSAFE',
          () => backend.readFileGuarded({ ...wsRef, relative_path: rel }),
          `逃逸路径 ${rel}`,
        );
        assert.match(err.message, new RegExp(reason), `${rel} 的理由应为 ${reason}：${err.message}`);
      }
    });
  });
});
