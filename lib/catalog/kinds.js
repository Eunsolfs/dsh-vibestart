/**
 * catalog/kinds.js — kind 的规范顺序、中文标签与一句话说明
 *
 * 15 个 kind 的**顺序**是快照 `rows` 每一位的含义载体（第 k 位对应
 * `kindOrder[k]`），所以这里把它固化成常量：
 *
 *   - `scripts/snapshot.mjs` 生成时断言上游 kinds 顺序与此一致，否则失败；
 *   - `tests/catalog.test.mjs` 断言快照里的 `kindOrder` 与此一致。
 *
 * 上游若调整顺序而这里没跟着改，字节级编码会静默错位——这是本文件存在
 * 的唯一理由，**不要**从快照里动态读取顺序来绕过它。
 *
 * 零 DSH import、零第三方依赖。
 */

/** 15 个 kind 的规范顺序（= 上游 v0.1.1 `--list --json` 的 kinds 数组顺序）。 */
export const KIND_ORDER = Object.freeze([
  'toolchain',
  'frontend',
  'framework',
  'router',
  'backend',
  'api',
  'database',
  'orm',
  'auth',
  'ui',
  'desktop',
  'mobile',
  'runtime',
  'deployment',
  'testing',
])

/** kind → 中文标签（工具结果、技能文案用；不含业务规则）。 */
export const KIND_LABELS = Object.freeze({
  toolchain: '工具链',
  frontend: '前端',
  framework: '框架',
  router: '路由',
  backend: '后端',
  api: 'API 层',
  database: '数据库',
  orm: 'ORM',
  auth: '认证',
  ui: 'UI 组件库',
  desktop: '桌面端',
  mobile: '移动端',
  runtime: '运行时',
  deployment: '部署',
  testing: '端到端测试',
})

/**
 * kind → 一句话说明。
 * 只描述「这个维度在 VibeStart 里管什么」，不替用户做产品决策——
 * 具体选哪个值由 `vibestart_plan` 校验后给命令。
 */
export const KIND_NOTES = Object.freeze({
  toolchain: '统一 dev / build / test / lint / format 的工具链，目前只有 Vite+。',
  frontend: '前端框架；选 none 表示不需要浏览器端。',
  framework: 'React 之上的应用框架：SPA、TanStack Start 或 Next.js。',
  router: '客户端路由方案，通常与 SPA 一起出现。',
  backend: '服务端：Hono 独立服务，或与前端同构的 self。',
  api: '前后端之间的接口层：oRPC 或 OpenAPI。',
  database: '数据库引擎；none 表示纯前端项目。',
  orm: '数据库访问层；与 database 搭配使用。',
  auth: '认证方案，目前是 Better Auth。',
  ui: 'UI 组件方案，目前是 shadcn/ui。',
  desktop: 'Electron 桌面端外壳。',
  mobile: 'Expo 移动端。',
  runtime: '服务端运行时：Node、Bun 或 Cloudflare Workers。',
  deployment: '部署产物：Docker 或 Cloudflare 的 Void。',
  testing: '端到端测试：Playwright，或旧版 e2e 入口。',
})

/**
 * kind 的中文标签；未知 kind 原样返回（不要抛错，渲染层不能炸）。
 * @param {unknown} id
 * @returns {string}
 */
export function kindLabel(id) {
  const key = String(id ?? '')
  return KIND_LABELS[key] ?? key
}

/**
 * kind 的一句话说明；未知 kind 返回空串。
 * @param {unknown} id
 * @returns {string}
 */
export function kindNote(id) {
  return KIND_NOTES[String(id ?? '')] ?? ''
}

/** 判断是否为本插件认得的 kind id。 */
export function isKnownKind(id) {
  return KIND_ORDER.includes(String(id ?? ''))
}
