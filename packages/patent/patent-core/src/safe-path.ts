/**
 * 专利域安全名字判定（单一事实源）。
 *
 * 两个判定对应两种概念，接受集不同且各自只有一份实现：
 * - {@link assertPathSegment}：单个路径段（案卷号、案例 id），允许非 ASCII。
 * - {@link assertDeliverableName}：落盘交付物的文件名主干，在路径段之上再加字符集与长度。
 *
 * 判定只抛错不做写盘；错误类型由调用方通过 `createError` 决定，各包保留自己的域错误。
 * @module @deepseek-ai/dsh-patent-core/safe-path
 */

/**
 * 交付文件名允许的字符：ASCII 字母数字与 `.` `_` `-` `()`、中文汉字、圈码 ①–⑳，
 * 以及草稿名常用的中文标点。空格不入列，落盘路径在 shell 与 URL 中仍可直接使用。
 */
const DELIVERABLE_NAME_CHARS = 'A-Za-z0-9._\\-()\\u4e00-\\u9fa5\\u2460-\\u2473\\u3001-\\u303F'
  + '\\uFF01\\uFF08\\uFF09\\uFF0C\\uFF1A\\uFF1B\\uFF1F\\uFF5E\\u00B7\\u2013\\u2014\\u2018-\\u201D\\u2026'

/** 交付文件名主干：字符集内 1–120 字符，且不含 `..` 段。 */
const DELIVERABLE_NAME_PATTERN = new RegExp(`^(?!.*\\.\\.)[${DELIVERABLE_NAME_CHARS}]{1,120}$`, 'u')

/**
 * 校验一个值可直接作为单段路径名：非空、不是 `.`/`..`、不以空格或点结尾、
 * 不含路径分隔符或 NUL。
 *
 * 允许中文等非 ASCII 字符：案卷号常写作 `CN2024-0001` 或中文案卷名，但仍不得越出
 * `data/cases/<caseId>/`。尾部空格和点在 Windows 上会被文件系统忽略，`".. "` 因而
 * 可能解析为父目录。
 * @param value - 待校验的路径段。
 * @param what - 错误消息中的对象名（如 "caseId" / "案卷号"）。
 * @param createError - 校验失败时构造领域错误。
 * @throws 当值不能作为单段路径名时，抛出 `createError` 构造的错误。
 */
export function assertPathSegment(
  value: string,
  what: string,
  createError: (message: string) => Error,
): void {
  if (
    value.trim() === '' ||
    value !== value.trim() ||
    value.endsWith('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw createError(
      `${what} ${JSON.stringify(value)} 不可用：必须是单段路径名，不得为空、含分隔符或 NUL，也不得以空白或点结尾`,
    )
  }
}

/**
 * 校验一个值可直接用作交付物文件名主干：`assertPathSegment` 的全部约束之上，
 * 再要求字符落在 {@link DELIVERABLE_NAME_CHARS} 内且长度为 1–120。
 * @param value - 待校验的文件名主干（不含扩展名）。
 * @param what - 错误消息中的对象名（如 "输出文件名" / "案卷号"）。
 * @param createError - 校验失败时构造领域错误。
 * @throws 当值不能作为交付物文件名时，抛出 `createError` 构造的错误。
 */
export function assertDeliverableName(
  value: string,
  what: string,
  createError: (message: string) => Error,
): void {
  assertPathSegment(value, what, createError)
  if (!DELIVERABLE_NAME_PATTERN.test(value)) {
    throw createError(
      `${what} ${JSON.stringify(value)} 不可用：只允许中英文、数字、圈码 ①–⑳ 与常用中文标点，`
      + '长度 1–120，不得含空格、路径分隔符或 `..`',
    )
  }
}
