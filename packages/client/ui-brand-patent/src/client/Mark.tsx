/**
 * DSH Patent brand mark and wordmark occupants for the generic brand slots.
 *
 * The official brand package gates itself behind
 * `DSH_CLIENT_BUILD_PROFILE === 'official'` (`ui-brand-official/src/client/index.ts`),
 * which a fork build never is, so a fork renders the shared fallbacks: the
 * official whale in the sidebar and the swimming fish in the blank-session
 * hero. This package takes the same slots so the fork shows its own mark, and
 * leaves the official package untouched for official builds.
 *
 * The mark is two interlocking hooks: `harness` in its literal sense, a
 * coupling. The left half reads as handing work in, the right half as
 * acceptance coming back, and the two tips crossing past the centreline is what
 * makes them read as two halves of one object rather than as two brackets.
 */

import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Mark geometry, in the 64-unit canvas every size variant shares.
 *
 * The two tip paths end past the centreline (x = 32), so the halves interlock:
 * a gap between them would read as two separate brackets.
 */
export const MARK_PATHS = {
  /** Left hook: primary-coloured body and its inward-pointing tip. */
  left: ['M24 14 L10 32 L24 50', 'M24 50 L33.6 42.4'],
  /** Right hook: accent-coloured body and its inward-pointing tip. */
  right: ['M40 14 L54 32 L40 50', 'M40 14 L30.4 21.6'],
} as const

/** Stroke weight for the standard mark, matching `brand/assets/mark.svg`. */
const STANDARD_STROKE = 6

/** The mark's own viewBox; every variant shares this canvas. */
export const MARK_VIEWBOX = { width: 64, height: 64 } as const

/**
 * Accent for the right hook: the theme's business-primary blue, which resolves
 * to the DeepSeek 500/400 pair in light and dark.
 *
 * Read through the alias token rather than a literal so the mark follows the
 * active palette; the brand spec's own `--dsp-mark-accent` would duplicate a
 * value this token already carries.
 */
const DEFAULT_ACCENT = 'var(--dsw-alias-state-business-primary)'

/** Presentation props accepted by {@link PatentMark}. */
interface PatentMarkProps extends IconProps {
  /**
   * Stroke weight override. Callers below 32 px pass the heavier weight so the
   * tips stay readable, matching the `mark-small` asset's 8-unit stroke.
   */
  stroke?: number
  /** Accent colour for the right hook; defaults to the business-primary blue. */
  accent?: string
}

/**
 * Render the DSH Patent mark.
 * @param props.size - square size in px (default 24).
 * @param props.className - extra class for layout placement.
 * @param props.stroke - stroke weight (default 6; use 8 below 32 px).
 * @param props.accent - right-hook colour (default: business-primary blue); the left hook always inherits `currentColor`.
 * @returns the mark svg (aria-hidden; pair it with the wordmark for accessibility).
 */
export function PatentMark({ size = 24, className, stroke = STANDARD_STROKE, accent = DEFAULT_ACCENT }: PatentMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${MARK_VIEWBOX.width} ${MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <g strokeLinecap="round" strokeLinejoin="round" fill="none">
        {MARK_PATHS.left.map(path => (
          <path key={path} d={path} stroke="currentColor" strokeWidth={stroke} />
        ))}
        {MARK_PATHS.right.map(path => (
          <path key={path} d={path} stroke={accent} strokeWidth={stroke} />
        ))}
      </g>
    </svg>
  )
}

/**
 * Pick the stroke weight a size needs.
 *
 * Below 32 px the standard 6-unit stroke thins until the crossing tips vanish
 * and the mark collapses into a small diamond; the 8-unit weight holds the two
 * hooks apart at 16 px. This mirrors the `mark.svg` / `mark-small.svg` split in
 * `brand/assets/`, which the icon generator already relies on.
 * @param size - rendered size in px.
 * @returns the stroke weight for that size.
 */
export function strokeForSize(size: number): number {
  return size < 32 ? 8 : STANDARD_STROKE
}
