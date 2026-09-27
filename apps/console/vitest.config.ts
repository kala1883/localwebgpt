/**
 * 控制台组件的测试配置（LWB-023）。
 *
 * ## 为什么本仓有两个测试运行器
 *
 * 其余的测试（`tests/**`、`packages/**`）跑在 `node --test --import tsx` 上，
 * 那个运行器直接执行 TypeScript 源码、**没有任何构建步骤** —— 这也是
 * `docs/compatibility.md` §2 记录的一条工程性质。
 *
 * 但 `.vue` 单文件组件不是 TypeScript：它的模板要经 Vue 的编译器处理，
 * tsx 不认这个格式。于是控制台这一层必须有一个能编译 SFC 的运行器，
 * 这就是 vitest。
 *
 * ## 两个运行器之间的分界靠**文件后缀**，而这是一个有意的选择
 *
 * | 后缀 | 运行器 |
 * | --- | --- |
 * | `*.test.ts` | `node --test`（`scripts/run-tests.mjs` 收集） |
 * | `*.spec.ts` | vitest（本文件收集） |
 *
 * 两个 `include`/收集规则**互不相交**，谁都不认对方的后缀。
 * 这样分而不是「按目录分」，是因为失败方向不同：
 *
 *  - 按后缀分：把 vitest 用例误写成 `.test.ts`，`node --test` 会**捡起它并报错**
 *    （它 import 了 `.vue`，直接运行必然失败）—— 一个响亮的、当场可见的失败。
 *  - 按目录分：同样写错时，两个运行器**都不收集它**，于是它永远不跑，
 *    而两边的输出都显示全部通过。这正是本工程反复记在偏离项 9 里的那种
 *    静默盲区。
 *
 * 因此这里选的是「错了会很吵」的那一种。
 */
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    // happy-dom 而不是 jsdom：本层的断言只用到 DOM 节点、文本与属性，
    // 不需要 jsdom 完整实现的导航、布局与样式计算，而 happy-dom 启动快得多
    // —— 快的那部分直接变成「组件测试愿不愿意跑」。
    environment: 'happy-dom',
    include: ['tests/**/*.spec.ts'],
    // 组件测试的失败信息里要能看见断言上下文，不被 vite 的进度输出淹没。
    reporters: ['default'],
  },
});
