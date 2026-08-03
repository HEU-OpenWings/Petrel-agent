/**
 * 校验路由守卫写进 URL 的 redirect 参数。
 *
 * 为什么需要：redirect 来自地址栏，任何人都能构造
 * `/login?redirect=https://evil.com` 发给受害者，登录成功后直接被送到钓鱼站——
 * 这是典型的开放重定向。所以只接受站内路径。
 *
 * 三个容易踩的点：
 * - `//evil.com` 会被浏览器当成协议相对 URL（等价于 https://evil.com），
 *   `/\evil.com` 在浏览器 URL 解析里等价于前者，所以「以 / 开头」还不够，
 *   必须排除第二个字符是 / 或 \ 的情况；
 * - 浏览器解析 URL 时会静默剥离 TAB / LF / CR，`/\t//evil.com` 解析后等价于
 *   `//evil.com`，光看开头两个字符会被绕过。这里对含控制字符的输入一律回落
 *   （不止 \t \n \r：正常站内路径本来就不该带任何 C0 控制字符或 DEL，
 *   直接整段拒掉比逐个剥离更难漏）；
 * - URL 里同名参数出现多次时（`?redirect=/a&redirect=//evil.com`），
 *   vue-router 给的是数组而不是字符串，非字符串一律回落；
 * - 目标是 /login 自身会让守卫打转：已登录访问 /login 时守卫又跳 redirect，
 *   拿到的还是 /login，vue-router 判为重复重定向并中止导航，人卡在登录页。
 *   守卫无条件把校验结果交给 next()，这里是唯一收敛点，所以在这里拒掉。
 */
// C0 控制字符（含 \0 \t \n \r）与 DEL
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * @param {unknown} value URL 里的 redirect 参数，可能是任意用户输入
 * @param {string} fallback 校验不通过时的目标。**必须是调用方硬编码的常量**，
 *   绝不能来自用户输入——本函数不校验它，传进来什么就返回什么。
 * @returns {string} 可安全交给 router.push()/next() 的站内路径
 */
export function safeRedirect(value, fallback = '/agent') {
  if (typeof value !== 'string') {
    return fallback
  }
  if (CONTROL_CHARS.test(value)) {
    return fallback
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback
  }
  // 只比 path 段：/login?x=1、/login#a 同样会打转，而 /loginxxx 是正常路径
  if (value.split(/[?#]/)[0] === '/login') {
    return fallback
  }
  return value
}
