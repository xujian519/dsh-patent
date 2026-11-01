/** Settings row: a title and description beside a trailing control. */
import type { ReactNode } from 'react'
import css from './SettingsRow.module.css'

/** Props for {@link SettingsRow}. */
export interface SettingsRowProps {
  /** Primary label. */
  title: string
  /** One-line explanation under the title. */
  description: string
  /** Trailing control, such as a switch or selector. */
  control: ReactNode
  /** Optional failure line under the description. */
  alert?: ReactNode | undefined
}

/**
 * Render one settings preference row.
 * @param props - the row's copy, its trailing control, and an optional failure line.
 * @returns the row.
 */
export function SettingsRow({ title, description, control, alert }: SettingsRowProps) {
  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{title}</div>
        <div className={css.description}>{description}</div>
        {alert}
      </div>
      {control}
    </div>
  )
}
