/**
 * 控制台一侧用到的共享常量。
 *
 * 只做转出，不重新定义 —— cookie 名与 CSRF 头名必须与服务端
 * **逐字一致**，而两份字符串字面量迟早会漂移，且漂移时
 * 「服务端照常设置、控制台照常找不到」，不会有任何检查报错。
 */

export { CONTROL_COOKIE_NAME, CONTROL_CSRF_HEADER } from '@lwb/contracts/control';
