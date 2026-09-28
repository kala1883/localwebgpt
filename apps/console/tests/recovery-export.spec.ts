import { createHash, webcrypto } from 'node:crypto';
import { afterEach, assert, describe, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RecoveryView from '../views/RecoveryView.vue';
import type { RecoveryExportClient, RecoveryRecord } from '../src/recovery/index.ts';

const SESSION = { authenticated: true } as const;
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalPickerDescriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');

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
  return new DOMException('The selected destination does not exist.', 'NotFoundError');
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

function harness(options: {
  readonly response?: Record<string, unknown>;
  readonly pickerError?: unknown;
  readonly targetExistsAt?: number;
} = {}) {
  vi.stubGlobal('crypto', webcrypto);
  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  const sequence: string[] = [];
  let destinationChecks = 0;
  const getFile = vi.fn(async () => {
    sequence.push('destination-check');
    destinationChecks += 1;
    if (options.targetExistsAt === destinationChecks) return { size: 12 };
    throw notFound();
  });
  const writable = {
    write: vi.fn(async (_data: Uint8Array) => { sequence.push('write'); }),
    close: vi.fn(async () => { sequence.push('close'); }),
    abort: vi.fn(async () => { sequence.push('abort'); }),
  };
  const handle = {
    name: 'chosen-recovery.snapshot',
    getFile,
    createWritable: vi.fn(async (creationOptions: unknown) => {
      sequence.push('create-writable');
      return writable;
    }),
  };
  const showSaveFilePicker = vi.fn(async () => {
    sequence.push('picker');
    if (options.pickerError !== undefined) throw options.pickerError;
    return handle;
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
  return { wrapper, bytes, showSaveFilePicker, handle, getFile, writable, authorizeMutation, call, sequence };
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
  if (originalPickerDescriptor) Object.defineProperty(window, 'showSaveFilePicker', originalPickerDescriptor);
  else Reflect.deleteProperty(window, 'showSaveFilePicker');
  vi.restoreAllMocks();
});

describe('LWB-037 recovery snapshot export', () => {
  it('opens the save picker first, verifies response bytes, writes only to the selected new file, and reports a receipt', async () => {
    const setup = harness();
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存 chosen-recovery\.snapshot/);
    });

    assert.deepEqual(setup.sequence.slice(0, 2), ['picker', 'destination-check']);
    assert.ok(setup.sequence.indexOf('picker') < setup.sequence.indexOf('authorize'));
    assert.deepEqual(setup.showSaveFilePicker.mock.calls[0]?.[0], {
      suggestedName: 'recovery-app.ts-original.snapshot',
      excludeAcceptAllOption: true,
      types: [{ description: 'LWB 恢复快照', accept: { 'application/octet-stream': ['.snapshot'] } }],
    });
    assert.equal(setup.getFile.mock.calls.length, 2);
    assert.deepEqual(setup.handle.createWritable.mock.calls[0]?.[0], { keepExistingData: false, mode: 'exclusive' });
    assert.deepEqual(Buffer.from(setup.writable.write.mock.calls[0]?.[0] ?? []), Buffer.from(setup.bytes));
    assert.equal(setup.writable.close.mock.calls.length, 1);
    assert.equal(setup.writable.abort.mock.calls.length, 0);

    const requestBody = setup.authorizeMutation.mock.calls[0]?.[2];
    assert.deepEqual(requestBody, {
      operation_id: 'op_1', item_id: 'item_1', snapshot: 'original', confirmed: true,
    });
    assert.equal(JSON.stringify(requestBody).includes('chosen-recovery.snapshot'), false);
    assert.equal(JSON.stringify(requestBody).includes('src/app.ts'), false);
    assert.deepEqual(setup.wrapper.emitted('export-complete')?.[0]?.[0], {
      operation_id: 'op_1',
      item_id: 'item_1',
      snapshot: 'original',
      file_name: 'chosen-recovery.snapshot',
      sha256: createHash('sha256').update(Buffer.from(setup.bytes)).digest('hex'),
      size: setup.bytes.byteLength,
    });
  });

  it('refuses an existing destination before requesting protected snapshot bytes', async () => {
    const setup = harness({ targetExistsAt: 1 });
    await exportSnapshot(setup.wrapper, 'original');

    assert.equal(setup.authorizeMutation.mock.calls.length, 0);
    assert.equal(setup.call.mock.calls.length, 0);
    assert.equal(setup.handle.createWritable.mock.calls.length, 0);
    assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /目标已经存在/);
    assert.equal(setup.wrapper.emitted('export-complete'), undefined);
  });

  it('does not write if the server response digest does not match its bytes', async () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const setup = harness({ response: responseFor(bytes, { sha256: '0'.repeat(64) }) });
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /SHA-256 校验失败/);
    });

    assert.equal(setup.call.mock.calls.length, 1);
    assert.equal(setup.handle.createWritable.mock.calls.length, 0);
    assert.equal(setup.writable.write.mock.calls.length, 0);
    assert.equal(setup.wrapper.emitted('export-complete'), undefined);
  });

  it('aborts the writable stream if the target appears during export', async () => {
    const setup = harness({ targetExistsAt: 2 });
    await exportSnapshot(setup.wrapper, 'original');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /目标已经存在/);
    });

    assert.equal(setup.handle.createWritable.mock.calls.length, 1);
    assert.equal(setup.writable.write.mock.calls.length, 0);
    assert.equal(setup.writable.close.mock.calls.length, 0);
    assert.equal(setup.writable.abort.mock.calls.length, 1);
    assert.equal(setup.wrapper.emitted('export-complete'), undefined);
  });

  it('does not request snapshot bytes when the operator cancels the native picker', async () => {
    const setup = harness({ pickerError: new DOMException('User cancelled.', 'AbortError') });
    await exportSnapshot(setup.wrapper, 'original');

    assert.equal(setup.authorizeMutation.mock.calls.length, 0);
    assert.equal(setup.call.mock.calls.length, 0);
    assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已取消导出/);
  });

  it('binds proposed-version export to its own one-time authorization subject', async () => {
    const bytes = Uint8Array.from([3, 4, 5, 250]);
    const setup = harness({
      response: responseFor(bytes, {
        snapshot: 'proposed',
        file_name: 'recovery-app.ts-proposed.snapshot',
      }),
    });
    await exportSnapshot(setup.wrapper, 'proposed');
    await vi.waitFor(() => {
      assert.match(setup.wrapper.find('[data-testid="export-status"]').text(), /已保存 chosen-recovery\.snapshot/);
    });

    assert.equal(setup.showSaveFilePicker.mock.calls[0]?.[0].suggestedName, 'recovery-app.ts-proposed.snapshot');
    assert.deepEqual(setup.authorizeMutation.mock.calls[0], [
      '/api/recovery/export_snapshot',
      'recovery-export:op_1:item_1:proposed',
      { operation_id: 'op_1', item_id: 'item_1', snapshot: 'proposed', confirmed: true },
    ]);
    assert.deepEqual(Buffer.from(setup.writable.write.mock.calls[0]?.[0] ?? []), Buffer.from(bytes));
    assert.equal(setup.wrapper.emitted('export-complete')?.[0]?.[0].snapshot, 'proposed');
  });
});
