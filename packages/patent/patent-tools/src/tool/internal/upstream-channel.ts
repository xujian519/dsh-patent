/**
 * 上游数据通道的模型可见身份：`patent_search` 与 `patent_metadata` 都从 Google Patents
 * 的 nuo 引擎取数。
 *
 * 检索报告要写明「每个事实用的通道、失败与覆盖范围」，这份事实必须能从工具调用记录
 * 回溯。只靠命中的 URL 反推通道，报告作者分不出「换了通道」与「同一通道重试」；因此
 * 两条工具的成功结果与失败消息都点名同一个常量，通道身份与失败文案只有这一处归属。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/upstream-channel
 */

/** Google Patents 通道的模型可见名称，nuo 引擎是它在本部署的实现。 */
export const GOOGLE_PATENTS_CHANNEL = 'Google Patents（nuo 引擎）'

/**
 * CNIPR 通道的模型可见名称：中国专利全文与法律状态的第二个通道，经 ego lite 登录态
 * 访问 search.cnipr.com（`@deepseek-ai/dsh-patent-data` 的 CNIPR 通道）。
 */
export const CNIPR_CHANNEL = 'CNIPR（中国知识产权网）'

/**
 * 上游以 429/503 答复被限流或过载的请求；nuo 把 HTTP 类失败的原文放进 detail
 * （`HTTP <status>[ …]`），因此这一族可以按状态码认出来，与超时、断连分开措辞。
 */
const UPSTREAM_RATE_LIMIT = /HTTP (429|503)/

/**
 * 渲染一次失败的上游查询：点名通道、上游错误与已尝试次数。
 *
 * 只有上游短语（`fetch failed`）时报告分不出事实出自哪个通道，而不写次数的重试提示
 * 会被读成「离开工具层」的邀请——通道名让调用记录自证，次数让调用方分得出首跑失败
 * 与退避后仍失败。
 *
 * 限流与瞬时失败的补救方式相反，故分开写：2026-10-03 实测，连续约 10 次请求后上游进入
 * HTTP 503，此后按秒级到分钟级间隔单发仍持续失败（至少 7.5 分钟），即这个窗口是分钟级的、
 * 工具内的退避吸收不了；把它写成「瞬时、可稍后重试」会请模型立刻再调一次，而每次调用又
 * 会向已限流的上游发出若干请求。
 * @param detail - 上游失败原文。
 * @param attempts - 已尝试的总次数。
 * @returns 模型可见的失败文案。
 */
export function renderUpstreamFailure(detail: string, attempts: number): string {
  const retried = attempts > 1 ? `；已退避重试 ${attempts - 1} 次仍未成功` : ''
  const remedy = UPSTREAM_RATE_LIMIT.test(detail)
    ? '；上游限流或过载（可持续数分钟），请间隔数分钟再试，不要在短时间内连续调用'
    : '；上游瞬时失败，可稍后重试'
  return `通道 ${GOOGLE_PATENTS_CHANNEL}：${detail}${retried}${remedy}`
}

/**
 * 把第二通道的告警接到失败文案后面：调用记录要能看出第二个通道也被问过。
 * @param report - 第一通道的失败文案。
 * @param warnings - 第二通道留下的告警；为空时原样返回。
 * @returns 拼接后的失败文案。
 */
export function appendSecondChannel(report: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? report : `${report}；${warnings.join('；')}`
}
