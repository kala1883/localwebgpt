/**
 * 操作注册表（LWB-008 步骤 2）。
 *
 * ## 为什么由服务端决定「这次调用需要什么能力」
 *
 * 直觉写法是让请求自己带上 `capability` 字段，服务端检查调用者是否拥有它。
 * 那是个**自证清白**的结构：调用者声称自己只需要低权限能力，
 * 服务端就会放行，而真正的操作仍然发生了。
 *
 * 因此能力要求绑定在**操作名**上，由服务端注册时声明。
 * 请求只能选操作名，选不了它需要什么权限。
 *
 * 注册表只提供机制，不含任何业务操作 —— 具体的操作由
 * `apps/daemon/src/control/` 注册，本包不认识工作区、文件或策略。
 */

import type { Audience, Capability } from './audience.ts';

export interface RequestContext {
  readonly audience: Audience;
  readonly connection_id: string;
  readonly pid: number;
  readonly request_id: string;
}

export interface OperationDefinition {
  readonly name: string;
  /** 调用它所需的能力。由服务端声明，请求方无法影响。 */
  readonly required: Capability;
  readonly handler: (input: unknown, context: RequestContext) => Promise<unknown> | unknown;
}

export class OperationRegistry {
  readonly #operations = new Map<string, OperationDefinition>();

  register(definition: OperationDefinition): void {
    if (this.#operations.has(definition.name)) {
      // 覆盖注册会让「实际生效的是哪一个」取决于加载顺序，
      // 而加载顺序在部署里是最容易被无意改变的东西。
      throw new Error(`操作 ${definition.name} 已注册，拒绝覆盖。`);
    }
    this.#operations.set(definition.name, definition);
  }

  lookup(name: string): OperationDefinition | undefined {
    return this.#operations.get(name);
  }

  names(): readonly string[] {
    return [...this.#operations.keys()].sort();
  }
}
