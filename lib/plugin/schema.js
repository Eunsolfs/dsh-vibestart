/**
 * plugin/schema.js — SchemaSpec 方言的构造助手 + 自检断言
 *
 * 三个工具的参数/输出 schema 都由这里产出，方言要点：
 *   - 根层属性用属性级 `required: true`
 *   - items / oneOf 内的嵌套对象不允许 `required`
 *   - 不支持 type 数组（可空用 oneOf 表达）
 *   - 不支持 numeric bounds（在 execute 内钳制）
 *   - object 必须显式声明 `additionalProperties` 为布尔值
 *
 * `assertToolSchemaDialect()` 把上述约束变成注册期可跑的断言：写错 schema 时
 * 在本地测试/自检阶段就报错，而不是等宿主加载后才炸。
 *
 * 本文件不 import 任何 DSH API——它只产出普通对象。
 */

const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])

const NUMERIC_BOUNDS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
])

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

/**
 * 字符串属性。
 * @param {string} description
 * @param {boolean} [required]
 */
export function text(description, required = false) {
  return { type: 'string', ...(required ? { required: true } : {}), description }
}

/**
 * 整数属性。边界在 execute 内钳制，不写进 schema。
 * @param {string} description
 * @param {boolean} [required]
 */
export function integer(description, required = false) {
  return { type: 'integer', ...(required ? { required: true } : {}), description }
}

/**
 * 布尔属性。
 * @param {string} description
 * @param {boolean} [required]
 */
export function boolean(description, required = false) {
  return { type: 'boolean', ...(required ? { required: true } : {}), description }
}

/**
 * 字符串枚举属性。
 * @param {readonly string[]} values
 * @param {string} description
 * @param {boolean} [required]
 */
export function stringEnum(values, description, required = false) {
  return {
    type: 'string',
    enum: [...values],
    ...(required ? { required: true } : {}),
    description,
  }
}

/**
 * 数组属性。
 * @param {object} items 元素 schema
 * @param {string} [description]
 * @param {boolean} [required]
 */
export function array(items, description = '', required = false) {
  return {
    type: 'array',
    items,
    ...(required ? { required: true } : {}),
    ...(description ? { description } : {}),
  }
}

/**
 * 对象属性。
 * @param {object} [properties]
 * @param {{additionalProperties?: boolean, description?: string, required?: boolean}} [options]
 */
export function object(properties = {}, options = {}) {
  const { additionalProperties = false, description = '', required = false } = options
  return {
    type: 'object',
    ...(Object.keys(properties).length ? { properties } : {}),
    additionalProperties,
    ...(required ? { required: true } : {}),
    ...(description ? { description } : {}),
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function scalarMatches(type, value) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return false
}

/**
 * 深度遍历 schema 节点并收集方言违规。
 * @param {object} node
 * @param {string} path
 * @param {{allowRequired?:boolean, insideItems?:boolean}} options
 * @param {string[]} violations
 */
export function walkSchemaNode(node, path, options, violations) {
  const { allowRequired = false, insideItems = false } = options
  if (!isPlainObject(node)) {
    violations.push(`${path} 必须是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (NUMERIC_BOUNDS.has(key)) {
      violations.push(`${path}.${key} 不支持数值边界（请在 execute 内钳制）`)
      continue
    }
    if (!ALLOWED_KEYWORDS.has(key)) violations.push(`${path}.${key} 不是 SchemaSpec 方言关键字`)
  }

  if (Object.hasOwn(node, 'required')) {
    if (node.required !== true) violations.push(`${path}.required 只能是 true（属性级）或省略`)
    if (!allowRequired || insideItems) {
      violations.push(`${path}.required 不允许出现在 items/oneOf 或根节点内`)
    }
  }

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) violations.push(`${path} 不能同时声明 type 与 oneOf`)
  if (!hasType && !hasOneOf) {
    violations.push(`${path} 必须声明 type 或 oneOf`)
    return
  }

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf 至少需要两个分支`)
      return
    }
    node.oneOf.forEach((branch, index) => {
      walkSchemaNode(branch, `${path}.oneOf[${index}]`, { allowRequired: false, insideItems: true }, violations)
    })
    return
  }

  const { type } = node
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    violations.push(
      Array.isArray(type)
        ? `${path}.type 不支持 type 数组（可空请用 oneOf）`
        : `${path}.type 必须是 ${[...SCHEMA_TYPES].join('/')} 之一`,
    )
    return
  }

  if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      violations.push(`${path}.enum 必须是非空数组`)
    } else if (!node.enum.every(value => scalarMatches(type, value))) {
      violations.push(`${path}.enum 的取值必须与 type=${type} 一致`)
    }
  }
  if (Object.hasOwn(node, 'const') && !scalarMatches(type, node.const)) {
    violations.push(`${path}.const 必须与 type=${type} 一致`)
  }

  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties 必须显式声明为 true/false`)
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!isPlainObject(node.properties)) {
        violations.push(`${path}.properties 必须是属性 schema 映射`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          walkSchemaNode(child, `${path}.properties.${key}`, { allowRequired: !insideItems, insideItems }, violations)
        }
      }
    }
  } else if (type === 'array') {
    if (!Object.hasOwn(node, 'items')) {
      violations.push(`${path}.items 必须声明元素 schema`)
    } else {
      walkSchemaNode(node.items, `${path}.items`, { allowRequired: false, insideItems: true }, violations)
    }
  }
}

/**
 * 校验一个工具定义对象的 schema 方言合规性。
 *
 * 检查：name / description 非空，parameters 为属性映射，output.schema 合规，
 * execute 是函数，render（若有）是函数。
 *
 * @param {object} tool
 * @returns {string[]} 违规项；空数组表示合规
 */
export function assertToolSchemaDialect(tool) {
  const violations = []
  if (!isPlainObject(tool)) return ['工具定义必须是对象']
  if (typeof tool.name !== 'string' || tool.name.trim() === '') violations.push('name 必须是非空字符串')
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    violations.push(`${tool.name ?? '?'}: description 必须是非空字符串`)
  }
  if (typeof tool.execute !== 'function') violations.push(`${tool.name ?? '?'}: execute 必须是函数`)

  if (!isPlainObject(tool.parameters)) {
    violations.push(`${tool.name ?? '?'}: parameters 必须是属性 schema 映射`)
  } else {
    for (const [key, child] of Object.entries(tool.parameters)) {
      walkSchemaNode(child, `parameters.${key}`, { allowRequired: true }, violations)
    }
  }

  if (tool.output !== undefined) {
    if (!isPlainObject(tool.output) || !isPlainObject(tool.output.schema)) {
      violations.push(`${tool.name ?? '?'}: output.schema 必须声明`)
    } else {
      walkSchemaNode(tool.output.schema, 'output.schema', {}, violations)
      if (tool.output.render !== undefined && typeof tool.output.render !== 'function') {
        violations.push(`${tool.name ?? '?'}: output.render 必须是函数`)
      }
    }
  }
  return violations
}

/**
 * 按 schema 校验一个运行时值（测试用）。
 * @param {object} spec
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function validateSpecValue(spec, value, path = 'value') {
  const violations = []
  validateValue(spec, value, path, violations)
  return violations
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateValue(spec, value, path, violations) {
  if (!isPlainObject(spec)) return
  if (Array.isArray(spec.oneOf)) {
    const ok = spec.oneOf.some(branch => validateSpecValue(branch, value, path).length === 0)
    if (!ok) violations.push(`${path} 不匹配任何 oneOf 分支`)
    return
  }
  const { type } = spec
  if (type === 'object') {
    if (!isPlainObject(value)) {
      violations.push(`${path} 应为 object，实际 ${describe(value)}`)
      return
    }
    const properties = isPlainObject(spec.properties) ? spec.properties : {}
    for (const [key, child] of Object.entries(properties)) {
      if (child.required === true && !Object.hasOwn(value, key)) {
        violations.push(`${path}.${key} 缺失（required）`)
      }
      if (Object.hasOwn(value, key)) validateValue(child, value[key], `${path}.${key}`, violations)
    }
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} 不允许（additionalProperties: false）`)
      }
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} 应为 array，实际 ${describe(value)}`)
      return
    }
    if (spec.items) value.forEach((item, index) => validateValue(spec.items, item, `${path}[${index}]`, violations))
    return
  }
  if (['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    if (!scalarMatches(type, value)) {
      violations.push(`${path} 应为 ${type}，实际 ${describe(value)}`)
      return
    }
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    violations.push(`${path} 不在 enum 允许值内: ${String(value)}`)
  }
  if (Object.hasOwn(spec, 'const') && spec.const !== value) {
    violations.push(`${path} 不等于 const 值`)
  }
}
