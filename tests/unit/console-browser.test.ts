import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openConsoleInDefaultBrowser } from '../../apps/daemon/src/lifecycle/console-browser.ts';

describe('default console browser', () => {
  const url = 'http://127.0.0.1:2930/#t=lwb_boot_disposable-test-token';

  it('passes the complete startup fragment to the browser once and waits for completion', async () => {
    const opened: string[] = [];
    const messages: string[] = [];
    let complete!: () => void;
    const pending = openConsoleInDefaultBrowser(url, {
      launch: async (target) => {
        opened.push(target);
        await new Promise<void>((resolve) => { complete = resolve; });
      },
      log: (message) => messages.push(message),
    });
    assert.deepEqual(opened, [url]);
    assert.equal(messages.length, 0);
    complete();
    assert.equal(await pending, true);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('Windows 默认浏览器'));
  });

  it('keeps browser errors non-fatal and does not log errors containing the startup token', async () => {
    const messages: string[] = [];
    assert.equal(await openConsoleInDefaultBrowser(url, {
      launch: async () => { throw new Error(`Browser failed: ${url}`); },
      log: (message) => messages.push(message),
    }), false);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes('手动打开'));
    assert.equal(messages.join('').includes('disposable-test-token'), false);
  });

  it('rejects invalid and non-console URLs before launching any process', async () => {
    for (const target of [
      'not-a-url',
      'https://example.com/#t=lwb_boot_fake',
      'http://localhost:2930/#t=lwb_boot_fake',
      'http://127.0.0.1:2930/other#t=lwb_boot_fake',
      'http://127.0.0.1:2930/?command=anything#t=lwb_boot_fake',
      'http://user:pass@127.0.0.1:2930/#t=lwb_boot_fake',
      'http://127.0.0.1:2930/',
    ]) {
      let launches = 0;
      assert.equal(await openConsoleInDefaultBrowser(target, {
        launch: async () => { launches += 1; }, log: () => {},
      }), false, target);
      assert.equal(launches, 0);
    }
  });
});
