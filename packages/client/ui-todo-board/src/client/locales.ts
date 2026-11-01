/** `todoBoard` namespace dictionaries for the cross-session board view. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'todoBoard'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.board': '看板',
  'board.aria': '任务看板',
  'column.pending': '待开始',
  'column.inProgress': '进行中',
  'column.completed': '已完成',
  'column.empty': '—',
  'card.jump': '跳转到会话 {session}：{content}',
  'filter.aria': '按标签筛选',
  'filter.all': '全部',
  'filter.tag': '筛选标签 {tag}',
  'empty.title': '还没有待办',
  'empty.hint':
    '任何会话通过 todo/write 工具写下任务清单后，都会出现在这块三列看板上。大致形状如下：',
  'empty.preview': '预览',
  'empty.previewTooltip':
    '形状预览——下面的卡片只用于示意三列布局；会话真正写入待办后，卡片会落在这里。',
  'empty.preview.pending': '起草发布说明',
  'empty.preview.inProgress': '重构压缩接缝',
  'empty.preview.completed': '合入产物预览 PR',
} satisfies Record<string, string>

/** The todoBoard dictionary key union. */
export type TodoBoardKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The cross-session board view copy: tabs, columns, cards, and empty state. */
    todoBoard: TodoBoardKey
  }
}

/** English dictionary, checked complete against the Chinese source of truth. */
export const en: Record<TodoBoardKey, string> = {
  'view.board': 'Board',
  'board.aria': 'Todo board',
  'column.pending': 'Pending',
  'column.inProgress': 'In Progress',
  'column.completed': 'Completed',
  'column.empty': '—',
  'card.jump': 'Jump to session {session}: {content}',
  'filter.aria': 'Filter by tag',
  'filter.all': 'All',
  'filter.tag': 'Filter by tag {tag}',
  'empty.title': 'No todos yet',
  'empty.hint':
    'Any session that writes todos through the todo/write tool lands in this three-column board. Here is the shape it takes:',
  'empty.preview': 'preview',
  'empty.previewTooltip':
    'Shape preview — the cards below illustrate the three-column layout; real todos land here once a session writes them via todo/write.',
  'empty.preview.pending': 'Draft the release notes',
  'empty.preview.inProgress': 'Refactor the compact seam',
  'empty.preview.completed': 'Land the artifact preview PR',
}
