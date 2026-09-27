/**
 * 逐条目判定：**现在盘上是什么**（LWB-030 步骤 2）。
 *
 * 方案 §8.4 给出四种情形，本文件把它们写成四个取值，而这一步是整个恢复
 * 流程里唯一**允许下结论**的地方 —— 后面所有决定都只是对这四格求和。
 *
 * | 判定 | §8.4 的说法 | 它凭什么成立 |
 * | --- | --- | --- |
 * | `ORIGINAL` | 当前身份/内容符合原状态 | 内容等于基线，**且对象还是被批准的那个**（改写）／名字还空着（创建） |
 * | `TARGET_REACHED` | 当前符合目标状态 | 内容等于目标，**且对象身份对得上** |
 * | `THIRD_CONTENT` | 当前是第三种内容 | 是一个读得到的、既非基线也非目标的内容 |
 * | `IDENTITY_UNKNOWN` | 身份变化、日志缺失或新建归属不明 | 上面三条都不成立 —— **不猜** |
 *
 * ## 两个判定词与 `ChangeFileState` **不是**一回事
 *
 * `ChangeFileState`（`RECOVERED_TARGET` / `RECOVERED_ORIGINAL` …）记的是
 * **这一条被怎么定案了**，是写进状态库的历史。本文件的判定说的是
 * **此刻观测到了什么**，是一个可以被重算的瞬时事实。同一份判定重算两次
 * 可以给出不同答案（中间有人改了那个文件），而一条定案一旦写下就不该再变。
 * 因此它们是两个词表，而不是一个词表的两个用途。
 *
 * ## 「内容等于目标」为什么不总能证明是我们写的
 *
 * 方案 §8.4 原文：「内容等于目标并不总能证明是谁写的。」本文件完全接受
 * 这句话，做法是**不声称归属**：判定叫 `TARGET_REACHED`（达到了目标状态），
 * 不叫「我们写成功了」。谁写的、什么时候写的，判定里一个字都没有 ——
 * 而恢复回执照着这个措辞写（见 `service.ts` 的 `receiptDetail`）。
 *
 * 接受这句话的**代价**恰好落在新建上：一个新建的文件没有基线身份
 * （`base_file_id` 是空的），于是「内容等于目标」少了唯一那个锚点。
 * §8.3 把这一格写得很直白 ——「不能猜测所有同名内容都属于插件」——
 * 因此创建条目在拿不到登录在案的观察身份时一律 `IDENTITY_UNKNOWN`，
 * 哪怕字节看起来一个不差。
 *
 * ## 这个文件是纯的
 *
 * 不读时钟、不碰数据库、不问进程。观测由调用方在受控句柄下做完再递进来，
 * 因此「判定」这件事可以被穷尽地摆开看 —— 见
 * `tests/unit/recovery-verdict.test.ts` 的判定表。
 */

import type { ChangeItemRecord } from '@lwb/persistence';

/**
 * 一次受控观测的结果。
 *
 * `absent` 与 `unavailable` 是**相反**的两件事，因此是两个取值而不是
 * 「可空的内容」：前者是「我看过了，那里没有东西」（一条事实），
 * 后者是「我没看成」（一条事实的缺席）。合成一个会让一次「文件不在了」
 * 与一次「护栏不可用」在代码里长得一模一样，而它们在 §8.4 里
 * 落在完全不同的两行上。
 */
export type Observation =
  | {
      readonly kind: 'present';
      /** `GetFileInformationByHandle` 的文件 ID。**这是对象身份，不是路径。** */
      readonly file_id: string;
      /** 内容哈希。观测被截断时调用方不该构造 `present`，见 `observationOf`。 */
      readonly sha256: string;
      readonly size: number;
      /**
       * 护栏给出的**磁盘规范拼写**（`canonical_relative_path`）。
       *
       * 它必须随观测一起被带上来，因为它是**唯一**能拿去写回的那个拼写：
       * 护栏的 `Assert-HandleMatches` 要求请求拼写与句柄的最终路径一致，
       * 而条目里存的那个拼写是**准备修改集时**的磁盘拼写。两者在
       * 「中间某级目录被改过大小写」之后会分叉 —— 那时用旧拼写去写，
       * 护栏会拒绝（正确地拒绝），而一次本该成功的收回会变成一次失败。
       */
      readonly canonical_path: string;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: UnknownReason; readonly detail: string };

/** 判不出「它是不是我们的那一个」的原因。**每一个都要能说出口。** */
export type UnknownReason =
  /** 护栏报告它自己不可用。**什么都没证明** —— 不是「没动过」，也不是「动过」。 */
  | 'GUARD_UNAVAILABLE'
  /** 读到了，但是截断的（`sha256 === null`）。截断不是空。 */
  | 'OBSERVATION_TRUNCATED'
  /** 别的读失败：权限、被占用、路径已不可达。 */
  | 'READ_FAILED'
  /**
   * 该在的文件不在了。
   *
   * 改写的那条路上，基线身份是「被批准的那一个对象」，而它消失了 ——
   * 这不是「回到了原状」，是现场少了一个东西。
   */
  | 'OBJECT_MISSING'
  /**
   * 内容对得上，但**对象不是被批准的那一个**。
   *
   * 同一份内容出现在另一个对象上，意味着原对象被替换过（删除后重建、
   * 改名后再建）。此时「写回去」会写到一个批准范围之外的对象上，
   * 因此 §8.4 把它归入「身份变化」。
   */
  | 'REPLACED_OBJECT'
  /**
   * 新建：内容等于目标，但**归属无从证明**。
   *
   * §8.3 原文：「新文件创建后到身份入库之间崩溃属于可能的模糊状态，
   * 不能猜测所有同名内容都属于插件。」一条内容相同、但账上没有登录过
   * 它身份的新文件，正落在这一句里。
   */
  | 'CREATED_IDENTITY_UNPROVEN';

export type ItemVerdict =
  | {
      readonly kind: 'ORIGINAL';
      /** 观测到的对象身份；创建一个「名字还空着」的条目时为 `null`。 */
      readonly observed_file_id: string | null;
      /** 观测到的内容哈希；「名字还空着」时为 `null`。 */
      readonly observed_sha256: string | null;
      /** 观测到的磁盘规范拼写；「名字还空着」时为 `null`。 */
      readonly observed_path: string | null;
      readonly detail: string;
    }
  | {
      readonly kind: 'TARGET_REACHED';
      readonly observed_file_id: string;
      readonly observed_sha256: string;
      readonly observed_path: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'THIRD_CONTENT';
      readonly observed_file_id: string;
      readonly observed_sha256: string;
      readonly observed_path: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'IDENTITY_UNKNOWN';
      readonly reason: UnknownReason;
      readonly detail: string;
    };

/**
 * 日志里关于这一个条目的事实。
 *
 * `observed_file_id` 取的是**最后一条带身份的事件**上的那个值 ——
 * 不是「出现过某个阶段」。「出现过」会把一次「写过、然后回滚失败」读成
 * 「写过」，而这两者的现场完全不同。
 */
export interface JournalEvidence {
  /**
   * 这一条在日志里的终局（`@lwb/executor` 的 `ItemOutcomeKind`）。
   *
   * `null` 表示**日志里根本没有这个条目** —— 它可能是还没轮到，
   * 也可能是账目被截断了。两者都不是「没动过」，因此由判定表各自处理。
   */
  readonly outcome: string | null;
  /** 这个条目的日志条数；0 表示日志里没有它。 */
  readonly events: number;
  /** 最后一条带非空身份的事件所观察到的对象身份。 */
  readonly observed_file_id: string | null;
  readonly observed_sha256: string | null;
}

export const NO_JOURNAL_EVIDENCE: JournalEvidence = {
  outcome: null,
  events: 0,
  observed_file_id: null,
  observed_sha256: null,
};

/**
 * 判定一条。
 *
 * 判定表（`edit_text` / `replace_text`）：
 *
 * | 观测 | 身份 | 内容 | 判定 |
 * | --- | --- | --- | --- |
 * | 读不到 | — | — | `IDENTITY_UNKNOWN`（原因照抄观测） |
 * | 不在 | — | — | `IDENTITY_UNKNOWN(OBJECT_MISSING)` |
 * | 在 | `= base_file_id` | `= target` | `TARGET_REACHED` |
 * | 在 | `= base_file_id` | `= base` | `ORIGINAL` |
 * | 在 | `≠ base_file_id` | 等于目标或基线 | `IDENTITY_UNKNOWN(REPLACED_OBJECT)` |
 * | 在 | 任意 | 其余 | `THIRD_CONTENT` |
 *
 * 判定表（`create_text`）：
 *
 * | 观测 | 判据 | 判定 |
 * | --- | --- | --- |
 * | 不在 | — | `ORIGINAL`（要建的东西没建出来） |
 * | 读不到 | — | `IDENTITY_UNKNOWN`（原因照抄观测） |
 * | 在 | 内容 = 目标，且日志里的身份 = 观测到的身份 | `TARGET_REACHED` |
 * | 在 | 内容 = 目标，其余 | `IDENTITY_UNKNOWN(CREATED_IDENTITY_UNPROVEN)` |
 * | 在 | 内容 ≠ 目标 | `THIRD_CONTENT` |
 *
 * 最后一行值得单独说：一个内容不是目标的新文件名，**不是**「我们写了然后
 * 被人改了」的证据，也不是「我们没写」的证据。它是「这个名字现在是别人的
 * 东西」——而 §8.4 对这一格的要求是保留现场。
 */
export function classifyItem(input: {
  readonly item: ChangeItemRecord;
  readonly observation: Observation;
  readonly journal: JournalEvidence;
}): ItemVerdict {
  const { item, observation, journal } = input;
  const path = item.canonical_path;

  if (item.op === 'create_text') return classifyCreated(path, item, observation, journal);

  // 以下都是改写（`edit_text` / `replace_text`）。基线与基线身份都必须有 ——
  // 没有的话这不是一条可以被判定的记录，而记录的不完整本身就是要报的事。
  if (item.base_file_id === null || item.base_sha256 === null) {
    return {
      kind: 'IDENTITY_UNKNOWN',
      reason: 'READ_FAILED',
      detail: `${path} 是一条改写，却没有基线身份或基线哈希；这一条无法被判定，保留现场。`,
    };
  }

  if (observation.kind === 'unavailable') {
    return { kind: 'IDENTITY_UNKNOWN', reason: observation.reason, detail: observation.detail };
  }
  if (observation.kind === 'absent') {
    return {
      kind: 'IDENTITY_UNKNOWN',
      reason: 'OBJECT_MISSING',
      detail: `${path} 在当前工作区里不存在。被批准的那个对象不在了，这不是「回到了原状」。`,
    };
  }

  const { file_id, sha256, canonical_path } = observation;
  const sameObject = file_id === item.base_file_id;
  const atTarget = sha256 === item.target_sha256;
  const atBase = sha256 === item.base_sha256;

  if (!sameObject && (atTarget || atBase)) {
    return {
      kind: 'IDENTITY_UNKNOWN',
      reason: 'REPLACED_OBJECT',
      detail:
        `${path} 的内容与${atTarget ? '目标' : '基线'}一致，但当前对象（${file_id}）` +
        `不是被批准的那一个（${item.base_file_id}）。对象被替换过，写回去会写到批准范围之外的对象上。`,
    };
  }

  if (sameObject && atTarget) {
    return {
      kind: 'TARGET_REACHED',
      observed_file_id: file_id,
      observed_sha256: sha256,
      observed_path: canonical_path,
      detail: `核验到目标状态：${path} 的当前对象与内容都等于本次批准的那一份。`,
    };
  }

  if (sameObject && atBase) {
    return {
      kind: 'ORIGINAL',
      observed_file_id: file_id,
      observed_sha256: sha256,
      observed_path: canonical_path,
      detail: `核验到原状态：${path} 的当前对象与内容都等于基线。`,
    };
  }

  return {
    kind: 'THIRD_CONTENT',
    observed_file_id: file_id,
    observed_sha256: sha256,
    observed_path: canonical_path,
    detail:
      `${path} 的当前内容既不是基线（${item.base_sha256}）也不是目标（${item.target_sha256}）；` +
      '它是一个第三种内容，本流程不覆盖它。',
  };
}

function classifyCreated(
  path: string,
  item: ChangeItemRecord,
  observation: Observation,
  journal: JournalEvidence,
): ItemVerdict {
  if (observation.kind === 'unavailable') {
    return { kind: 'IDENTITY_UNKNOWN', reason: observation.reason, detail: observation.detail };
  }
  if (observation.kind === 'absent') {
    return {
      kind: 'ORIGINAL',
      observed_file_id: null,
      observed_sha256: null,
      observed_path: null,
      detail: `核验到原状态：${path} 这个新建目标还不存在，本次创建没有留下任何东西。`,
    };
  }

  const { file_id, sha256, canonical_path } = observation;

  if (sha256 !== item.target_sha256) {
    return {
      kind: 'THIRD_CONTENT',
      observed_file_id: file_id,
      observed_sha256: sha256,
      observed_path: canonical_path,
      detail:
        `${path} 现在存在，但内容不是本次创建的目标（期望 ${item.target_sha256}，实际 ${sha256}）；` +
        '这个名字现在是别的内容，本流程不覆盖它。',
    };
  }

  // 内容等于目标。新建没有基线身份可锚，唯一能证明「它就是我们建的那一个」
  // 的东西是**登录在案的观察身份**（`item_written` / `item_verified` 上那个）。
  if (journal.observed_file_id === null || journal.observed_file_id !== file_id) {
    return {
      kind: 'IDENTITY_UNKNOWN',
      reason: 'CREATED_IDENTITY_UNPROVEN',
      detail:
        `${path} 的内容等于本次创建的目标，但新建对象归属无从证明` +
        `（账上登录的身份 ${journal.observed_file_id ?? '无'}，当前对象 ${file_id}）。` +
        '§8.3：不能猜测同名内容都属于插件。',
    };
  }

  return {
    kind: 'TARGET_REACHED',
    observed_file_id: file_id,
    observed_sha256: sha256,
    observed_path: canonical_path,
    detail:
      `核验到目标状态：${path} 的对象身份与内容都与本次创建执行登录在案的那一份一致。`,
  };
}

/**
 * 把护栏回执翻译成一次观测。
 *
 * **`sha256 === null` 是「截断」，不是「空文件」。** 本工程在别处也写过
 * 同一句话（`native-adapter.ts` 的观测完整性判定），而在这里它的后果是
 * 具体的：一次截断的读如果被当成 `present`，那个空哈希会与任何一个
 * 真实哈希都不相等，于是落到 `THIRD_CONTENT` —— 而 `THIRD_CONTENT` 的
 * 含义是「有一个我们不该覆盖的内容」。**它是同一个文件**，只是没读完。
 * 因此截断必须走 `unavailable`。
 */
export function observationOf(read: {
  readonly ok: true;
  readonly file_id: string;
  readonly sha256: string | null;
  readonly size: number;
  readonly canonical_path: string;
} | {
  readonly ok: false;
  readonly reason: UnknownReason;
  readonly detail: string;
}): Observation {
  if (!read.ok) return { kind: 'unavailable', reason: read.reason, detail: read.detail };
  if (read.sha256 === null) {
    return {
      kind: 'unavailable',
      reason: 'OBSERVATION_TRUNCATED',
      detail: '这一次读取被截断（哈希为空）。截断不等于空内容，因此不作任何判定。',
    };
  }
  return {
    kind: 'present',
    file_id: read.file_id,
    sha256: read.sha256,
    size: read.size,
    canonical_path: read.canonical_path,
  };
}
