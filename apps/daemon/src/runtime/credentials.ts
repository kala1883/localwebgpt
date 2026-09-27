/**
 * 装配根需要的两类凭证（装配根）。
 *
 * ## 三类凭证里，本模块用到两类
 *
 * `@lwb/secure-store` 定义了 `runtime` / `ipc` / `console` 三类。装配根
 * 今天用前两类：
 *
 * | 类 | 载荷 | 谁需要它 |
 * | --- | --- | --- |
 * | `runtime` | 读取票据的 HMAC 密钥 | 只有 daemon（`createReadTicketAuthority`） |
 * | `ipc` | 两个 audience 的握手密钥 | daemon 与适配器 |
 *
 * `console` 类暂时不用：控制台的会话凭证是**内存里的**（`ControlSessionStore`），
 * 它按设计不落盘 —— 落盘会让「关掉控制台就等于登出」这句话不成立。
 * 这一格留空是刻意的，不是遗漏。
 *
 * ## 载荷是 JSON，但 `CredentialStore` 只认字符串
 *
 * `CredentialStore.set` 的载荷是 `{kind, secret: string}`，因此这里的
 * 多字段载荷编码成 JSON 字符串塞进 `secret`。**这是有意的临时形状**：
 * 与其在凭证格式上加一层「值可以是对象」，不如让编码/解码只发生在
 * 本文件的两个函数里 —— 那一层的失效方式是「某处忘了 JSON.parse」，
 * 而它会在启动时立刻抛出来。
 *
 * ## 缺失就创建，损坏就拒绝启动
 *
 * 两者必须分开：凭证**不存在**是一个正常状态（第一次启动），此时生成一把
 * 新的即可；凭证**解不开**（换了用户、文件被换掉、DPAPI 域不符）绝不能
 * 顺手生成新的 —— 那会把「密钥被换掉」这件事伪装成「首次启动」，
 * 而后果是此前签发过的全部票据与游标静默失效、或者更糟：两个进程
 * 各自拿一把不同的密钥，各自都「工作正常」。
 */

import { randomBytes } from 'node:crypto';

import type { AudienceSecrets } from '@lwb/ipc';
import { AUDIENCES, assertAudienceSecretsDistinct } from '@lwb/ipc';
import type { CredentialClass, CredentialStore } from '@lwb/secure-store';
import { fingerprintOf } from '@lwb/secure-store';

export interface RuntimeKeys {
  /** 读取票据 / 游标的 HMAC 密钥（`createReadTicketAuthority`）。 */
  readonly ticket_key: string;
}

export interface CredentialProvision {
  readonly value: RuntimeKeys;
  readonly created: boolean;
  /** 供启动日志使用：只有指纹与创建时刻，**不含机密**。 */
  readonly fingerprint: string;
}

export interface IpcCredentialProvision {
  readonly value: AudienceSecrets;
  readonly created: boolean;
  readonly fingerprint: string;
}

const RUNTIME_KIND = 'runtime-keys';
const IPC_KIND = 'ipc-audience-secrets';

/** 随机密钥的字节数。32 字节 = HMAC-SHA256 的密钥长度，也是 `rotate` 的长度。 */
const SECRET_BYTES = 32;

function randomSecret(): string {
  // 用 `base64url` 而不是 hex：同样的熵更短，且不会在 JSON 里被转义。
  return randomBytes(SECRET_BYTES).toString('base64url');
}

interface StoredPayload {
  readonly kind: string;
  readonly secret: string;
}

function encodePayload(kind: string, value: unknown): StoredPayload {
  return { kind, secret: JSON.stringify(value) };
}

function decodePayload<T>(cls: CredentialClass, raw: StoredPayload, expectKind: string, parse: (value: unknown) => T): T {
  if (raw.kind !== expectKind) {
    throw new Error(
      `凭证 ${cls} 的类别标记是「${raw.kind}」，期望「${expectKind}」；拒绝启动。` +
        '就地重建会让「凭证被换成了另一类」看起来像一次首次启动。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.secret);
  } catch {
    throw new Error(`凭证 ${cls} 的载荷不是合法 JSON；拒绝启动。`);
  }
  return parse(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 取（或首次创建）运行时密钥。
 *
 * `exists()` 先问一次而不是靠 `reveal()` 抛错来区分「不存在」与「损坏」：
 * 后者的两种失败在错误信息上很接近，而它们的处置相反（建一把新的 vs 拒绝启动）。
 */
export async function loadRuntimeKeys(store: CredentialStore): Promise<CredentialProvision> {
  if (!store.exists('runtime')) {
    const value: RuntimeKeys = { ticket_key: randomSecret() };
    const info = await store.set('runtime', encodePayload(RUNTIME_KIND, value));
    return { value, created: true, fingerprint: info.fingerprint };
  }

  const raw = await store.reveal('runtime');
  const value = decodePayload('runtime', raw, RUNTIME_KIND, (parsed) => {
    if (!isRecord(parsed) || typeof parsed['ticket_key'] !== 'string' || parsed['ticket_key'].length === 0) {
      throw new Error('运行时凭证缺少 ticket_key；拒绝启动。');
    }
    return { ticket_key: parsed['ticket_key'] };
  });
  // 指纹由**明文**算：`info()` 会解密，但它的返回值里已经带指纹，
  // 而这里反正已经把明文取出来了，再调一次 `info()` 只是多一次解密。
  return { value, created: false, fingerprint: fingerprintOf(raw.secret) };
}

/**
 * 取（或首次创建）IPC 握手密钥。
 *
 * 校验分两层：形状（两个 audience 各一把、非空）与 `assertAudienceSecretsDistinct`
 * （两把**不相同**）。后者在 `@lwb/ipc` 里已经存在 —— 共用一把密钥会让
 * audience 分离失效（模型侧的连接就能用控制台的能力），而那种失效
 * 在功能上完全看不出来。这里调用它，而不是重写一遍判据。
 */
export async function loadIpcSecrets(store: CredentialStore): Promise<IpcCredentialProvision> {
  if (!store.exists('ipc')) {
    const secrets: Record<string, string> = {};
    for (const audience of AUDIENCES) secrets[audience] = randomSecret();
    const value = secrets as unknown as AudienceSecrets;
    assertAudienceSecretsDistinct(value);
    const info = await store.set('ipc', encodePayload(IPC_KIND, value));
    return { value, created: true, fingerprint: info.fingerprint };
  }

  const raw = await store.reveal('ipc');
  const value = decodePayload('ipc', raw, IPC_KIND, (parsed) => {
    if (!isRecord(parsed)) throw new Error('IPC 凭证的载荷不是一个对象；拒绝启动。');
    const out: Record<string, string> = {};
    for (const audience of AUDIENCES) {
      const secret = parsed[audience];
      if (typeof secret !== 'string' || secret.length < 16) {
        // 长度下限与适配器侧的 `loadConfig` 一致（那里的下限是 16）。
        // 不一致的话，daemon 会正常启动、而适配器每次都在握手前退出，
        // 表现是「隧道连不上」，方向被引到网络那一侧。
        throw new Error(`IPC 凭证缺少 audience「${audience}」的密钥，或长度不足 16；拒绝启动。`);
      }
      out[audience] = secret;
    }
    return out as unknown as AudienceSecrets;
  });
  assertAudienceSecretsDistinct(value);
  return { value, created: false, fingerprint: fingerprintOf(raw.secret) };
}
