/**
 * 报文分帧（LWB-008）。
 *
 * 行分隔的 JSON，加一条**硬上限**。上限不是为了性能，而是因为
 * 一个不设限的本地接口是可以被自己人打垮的：适配器进程卡住后仍能写入，
 * daemon 会一直攒缓冲区直到 OOM —— 而 daemon 死掉会让写入中途停止，
 * 正是 I09/I11 最不希望的处境。
 *
 * 超限时**断开连接**而不是丢弃那一行：丢弃会让发送方以为发出去了。
 */

/** 单条报文上限。方案 §9.3 的「MCP 单请求 JSON 1 MiB」再加分帧开销。 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  readonly size: number;
  constructor(size: number) {
    super(`单条报文超过上限（${size} > ${MAX_FRAME_BYTES} 字节），已断开该连接。`);
    this.name = 'FrameTooLargeError';
    this.size = size;
  }
}

export class FrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameParseError';
  }
}

export function encodeFrame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new FrameParseError('无法序列化的值，拒绝发送。');
  }
  const bytes = Buffer.from(`${json}\n`, 'utf8');
  if (bytes.length > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(bytes.length);
  }
  return bytes;
}

/**
 * 增量解帧器。
 *
 * 有状态的：TCP/管道的一次 `data` 事件与一次逻辑报文**没有**对应关系。
 * 把它做成一个类而不是函数，是为了让「半个包留在缓冲区里」这个状态
 * 有明确的归属，而不是散在闭包里。
 */
export class FrameDecoder {
  #buffer = '';
  #discarded = false;

  /**
   * 喂入一段数据，取出其中完整的报文。
   *
   * @throws FrameTooLargeError 缓冲区超过上限；抛出后本解码器进入废弃状态，
   *   调用方必须断开连接（继续解析会让攻击者用超大报文拖垮进程）。
   */
  push(chunk: string): unknown[] {
    if (this.#discarded) return [];
    this.#buffer += chunk;

    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_FRAME_BYTES) {
      const size = Buffer.byteLength(this.#buffer, 'utf8');
      this.#buffer = '';
      this.#discarded = true;
      throw new FrameTooLargeError(size);
    }

    const out: unknown[] = [];
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) {
        out.push(JSON.parse(line) as unknown);
      }
      index = this.#buffer.indexOf('\n');
    }
    return out;
  }

  /** 连接结束时是否还有半个报文；用于把这个事实记进审计而不是静默丢弃。 */
  get pendingBytes(): number {
    return Buffer.byteLength(this.#buffer, 'utf8');
  }

  get discarded(): boolean {
    return this.#discarded;
  }
}
