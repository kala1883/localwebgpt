import { createHash, webcrypto } from 'node:crypto';
import { afterEach, assert, describe, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RecoveryView from '../views/RecoveryView.vue';
import type { RecoveryExportClient, RecoveryRecord } from '../src/recovery/index.ts';

const SESSION = { authenticated: true } as const;
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalDirectoryPickerDescriptor = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');
const originalSaveFilePickerDescriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');

function recordOf(): RecoveryRecord {
  return {
    operation_id: 'op_1',
    change_id: 'chg_1',
    workspace_id: 'ws_1',
    operation_state: 'RECOVERY_REQUIRED',
    change_state: 'RECOVERY_REQUIRED',
    recovered: false,
    observed_at: '2026-09-27T00:00:00.000Z',
    plan_digest: 'd'.repeat(64),
    plan: { kind: 'ok', action: 'ROLLBACK_TO_BASELINE', digest: 'd'.repeat(64), targets: ['src/app.ts'] },
    items: [{
      item_id: 'item_1', path: 'src/app.ts', op: 'edit_text',
      original_sha256: 'a'.repeat(64), proposed_sha256: 'b'.repeat(64), current_sha256: 'c'.repeat(64),
      current_state: 'THIRD_CONTENT', reason: 'REPLACED_OBJECT', error_code: null,
      updated_at: '2026-09-27T00:00:00.000Z',
    }],
    authorizations: [],
    journal: [],
  };
}

function notFound(): DOMException {
  return new DOMException('The requested entry does not exist.', 'NotFoundError');
}

function responseFor(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const content = Buffer.from(bytes);
  return {
    operation_id: 'op_1',
    item_id: 'item_1',
    snapshot: 'original',
    file_name: 'recovery-app.ts-original.snapshot',
    content_type: 'application/octet-stream',
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    content_base64: content.toString('base64'),
    ...overrides,
  };
}

function nameFor(snapshot: 'original' | 'proposed', uuid: string): string {
  return `recovery-app.ts-${snapshot}-${uuid}.snapshot`;
}

function harness(options: {
  readonly response?: Record<string, unknown>;
  readonly pickerError?: unknown;
  readonly existingFiles?: Readonly<Record<string, Uint8Array>>;
  readonly uuidSequence?: readonly string[];
  readonly fileAppearingDuringCreate?: string;
} = {}) {
  const uuidQueue = [...(options.uuidSequence ?? [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ])];
  const randomUUID = vi.fn(() => uuidQueue.shift() ?? '00000000-0000-4000-8000-000000000099');
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID });

  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  const sequence: string[] = [];
  const files = new Map<string, ReturnType<typeof makeFileHandle>>();

  function makeFileHandle(name: string, initialBytes: Uint8Array) {
    let currentBytes = Uint8Array.from(initialBytes);
    const writable = {
      write: vi.fn(async (data: Uint8Array) => {
        sequence.push(`write:${name}`);
        currentBytes = Uint8Array.from(data);
      }),
      close: vi.fn(async () => { sequence.push(`close:${name}`); }),
      abort: vi.fn(async () => { sequence.push(`abort:${name}`); }),
    };
    const handle = {
      name,
      getFile: vi.fn(async () => ({ size: currentBytes.byteLength })),
      createWritable: vi.fn(async (creationOptions: unknown) => {
        sequence.push(`create-writable:${name}`);
        return writable;
      }),
    };
    return { handle, writable, getBytes: () => Uint8Array.from(currentBytes) };
  }

  for (const [name, initialBytes] of Object.entries(options.existingFiles ?? {})) {
    files.set(name, makeFileHandle(name, initialBytes));
  }

  const getFileHandle = vi.fn(async (name: string, pickerOptions?: { readonly create?: boolean }) => {
    sequence.push(`${pickerOptions?.create === true ? 'create' : 'lookup'}:${name}`);
    const existing = files.get(name);
    if (existing) return existing.handle;
    if (pickerOptions?.create !== true) throw notFound();
    if (options.fileAppearingDuringCreate === name) {
      const raced = makeFileHandle(name, Uint8Array.from([9, 8, 7]));
      files.set(name, raced);
      return raced.handle;
    }
    const created = makeFileHandle(name, new Uint8Array());
    files.set(name, created);
    return created.handle;
  });
  const directory = { name: 'chosen-folder', getFileHandle };
  const showDirectoryPicker = vi.fn(async () => {
    sequence.push('directory-picker');
    if (options.pickerError !== undefined) throw options.pickerError;
    return directory;
  });
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: showDirectoryPicker,
  });
  const showSaveFilePicker = vi.fn(async () => {
    throw new Error('Recovery export must not use the destructive file-level save picker.');
  });
  Object.defineProperty(window, 'showSaveFilePicker', {
    configurable: true,
    value: showSaveFilePicker,
  });

  const authorizeMutation = vi.fn(async (_operation: string, subject: string, body: Record<string, unknown>) => {
    sequence.push('authorize');
    return { ...body, subject, nonce: 'nonce_once' };
  });
  const call = vi.fn(async (_path: string, _body: Record<string, unknown>) => {
    sequence.push('fetch-snapshot');
    return options.response ?? responseFor(bytes);
  });
  const client: RecoveryExportClient = { authorizeMutation, call };
  const wrapper = mount(RecoveryView, {
    props: { record: recordOf(), session: SESSION, exportClient: client },
  });
  return {
    wrapper, bytes, directory, files, getFileHandle, showDirectoryPicker, showSaveFilePicker,
    authorizeMutation, call, sequence, randomUUID,
  };
}

async function exportSnapshot(
  wrapper: ReturnType<typeof mount>,
  snapshot: 'original' | 'proposed',
): Promise<void> {
  await wrapper.find('[data-testid="export-confirm"] input').setValue(true);
  await wrapper.find(`[data-testid="export-${snapshot}"]`).trigger('click');
  await flushPromises();
}

afterEach(() => {
  if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  else Reflect.deleteProperty(globalThis, 'crypto');
  if (originalDirectoryPickerDescriptor) Object.defineProperty(window, 'showDirectoryPicker', originalDirectoryPickerDescriptor);
  else Reflect.deleteProperty(window, 'showDirectoryPicker');
  if (originalSaveFilePickerDescriptor) Object.defineProperty(window, 'showSaveFilePicker', originalSaveFilePickerDescriptor);
  else Reflect.deleteProperty(window, 'showSaveFilePicker');
  vi.restoreAllMocks();
});

describe('LWB-037 recovery snapshot export', () => {
  it('asks for a directory before API access and writes verified bytes to a generated new filename', async () => {
    const setup = harness();
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存到 chosen-folder\/recovery-app\.ts-original-/);
    });

    assert.deepEqual(setup.showDirectoryPicker.mock.calls[0]?.[0], {
      id: 'lwb-recovery-export', mode: 'readwrite',
    });
    assert.equal(setup.showSaveFilePicker.mock.calls.length, 0);
    assert.ok(setup.sequence.indexOf('directory-picker') < setup.sequence.indexOf('authorize'));
    assert.ok(setup.sequence.indexOf('fetch-snapshot') < setup.sequence.findIndex((entry) => entry.startsWith('create:')));
    assert.equal(setup.files.size, 1);

    const [fileName, file] = [...setup.files.entries()][0] ?? [];
    assert.ok(fileName?.match(/^recovery-app\.ts-original-[0-9a-f-]{36}\.snapshot$/));
    assert.deepEqual(file?.getBytes(), setup.bytes);
    assert.deepEqual(file?.handle.createWritable.mock.calls[0]?.[0], { keepExistingData: false, mode: 'exclusive' });
    assert.equal(file?.writable.close.mock.calls.length, 1);
    assert.equal(file?.writable.abort.mock.calls.length, 0);

    const requestBody = setup.authorizeMutation.mock.calls[0]?.[2];
    assert.deepEqual(requestBody, {
      operation_id: 'op_1', item_id: 'item_1', snapshot: 'original', confirmed: true,
    });
    assert.equal(JSON.stringify(requestBody).includes('chosen-folder'), false);
    assert.equal(JSON.stringify(requestBody).includes('src/app.ts'), false);
    assert.deepEqual(setup.wrapper.emitted('export-complete')?.[0]?.[0], {
      operation_id: 'op_1',
      item_id: 'item_1',
      snapshot: 'original',
      file_name: fileName,
      sha256: createHash('sha256').update(Buffer.from(setup.bytes)).digest('hex'),
      size: setup.bytes.byteLength,
    });
  });

  it('detects a same-name collision without opening or changing the existing file, then uses a fresh name', async () => {
    const collision = nameFor('original', '00000000-0000-4000-8000-000000000001');
    const originalBytes = Uint8Array.from([44, 55, 66]);
    const setup = harness({
      existingFiles: { [collision]: originalBytes },
      uuidSequence: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    });
    const existing = setup.files.get(collision);
    assert.ok(existing);
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存到 chosen-folder\/recovery-app\.ts-original-/);
    });

    assert.deepEqual(existing.getBytes(), originalBytes);
    assert.equal(existing.handle.getFile.mock.calls.length, 0);
    assert.equal(existing.handle.createWritable.mock.calls.length, 0);
    assert.equal(existing.writable.write.mock.calls.length, 0);
    assert.equal(setup.files.size, 2);
    const created = setup.files.get(nameFor('original', '00000000-0000-4000-8000-000000000002'));
    assert.deepEqual(created?.getBytes(), setup.bytes);
    assert.equal(setup.wrapper.emitted('export-complete')?.[0]?.[0].file_name, created?.handle.name);
  });

  it('does not write to a candidate that becomes non-empty between lookup and creation', async () => {
    const racedName = nameFor('original', '00000000-0000-4000-8000-000000000001');
    const setup = harness({
      fileAppearingDuringCreate: racedName,
      uuidSequence: [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ],
    });
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存到 chosen-folder\/recovery-app\.ts-original-/);
    });

    const raced = setup.files.get(racedName);
    assert.deepEqual(raced?.getBytes(), Uint8Array.from([9, 8, 7]));
    assert.equal(raced?.writable.write.mock.calls.length, 0);
    assert.equal(raced?.handle.createWritable.mock.calls.length, 0);
    const created = setup.files.get(nameFor('original', '00000000-0000-4000-8000-000000000002'));
    assert.deepEqual(created?.getBytes(), setup.bytes);
  });

  it('does not create an output file if the server response digest does not match its bytes', async () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const setup = harness({ response: responseFor(bytes, { sha256: '0'.repeat(64) }) });
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /SHA-256 校验失败/);
    });

    assert.equal(setup.call.mock.calls.length, 1);
    assert.equal(setup.getFileHandle.mock.calls.length, 0);
    assert.equal(setup.files.size, 0);
    assert.equal(setup.wrapper.emitted('export-complete'), undefined);
  });

  it('does not request snapshot bytes when the operator cancels directory selection', async () => {
    const setup = harness({ pickerError: new DOMException('User cancelled.', 'AbortError') });
    await exportSnapshot(setup.wrapper, 'original');

    assert.equal(setup.authorizeMutation.mock.calls.length, 0);
    assert.equal(setup.call.mock.calls.length, 0);
    assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已取消导出/);
  });

  it('binds proposed-version export to its own one-time authorization subject and filename', async () => {
    const bytes = Uint8Array.from([3, 4, 5, 250]);
    const uuid = '00000000-0000-4000-8000-000000000001';
    const setup = harness({
      response: responseFor(bytes, {
        snapshot: 'proposed',
        file_name: 'recovery-app.ts-proposed.snapshot',
      }),
      uuidSequence: [uuid],
    });
    await exportSnapshot(setup.wrapper, 'proposed');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存到 chosen-folder\/recovery-app\.ts-proposed-/);
    });

    assert.deepEqual(setup.authorizeMutation.mock.calls[0], [
      '/api/recovery/export_snapshot',
      'recovery-export:op_1:item_1:proposed',
      { operation_id: 'op_1', item_id: 'item_1', snapshot: 'proposed', confirmed: true },
    ]);
    const created = setup.files.get(nameFor('proposed', uuid));
    assert.deepEqual(created?.getBytes(), bytes);
    assert.equal(setup.wrapper.emitted('export-complete')?.[0]?.[0].snapshot, 'proposed');
  });
});
