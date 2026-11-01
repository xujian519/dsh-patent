/**
 * The trajectory split's resize separator: the inspector width and tool-request offset it drives,
 * the clamps bounding them, and the pointer and keyboard handlers bound to it.
 */

import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

const DETAILS_MIN_WIDTH = 320

const DETAILS_MAX_WIDTH = 720

const TABLE_MIN_WIDTH = 280

const DETAILS_RESIZE_STEP = 16

const TOOL_REQUEST_SHARE = 0.58

const TOOL_REQUEST_MIN_WIDTH = 180

const TOOL_REQUEST_MAX_WIDTH = 480

const DEFAULT_TOOL_REQUEST_SHARE = 0.36

const DEFAULT_TOOL_REQUEST_OFFSET = 56

interface DetailsResizeDrag {
  pointerId: number
  startX: number
  startWidth: number
  splitWidth: number
  startToolRequestOffset: number
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maxWidth = Math.max(
    DETAILS_MIN_WIDTH,
    Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH),
  )
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maxWidth))
}

function defaultToolRequestWidth(splitWidth: number): number {
  return Math.min(
    Math.max(
      splitWidth * DEFAULT_TOOL_REQUEST_SHARE - DEFAULT_TOOL_REQUEST_OFFSET,
      TOOL_REQUEST_MIN_WIDTH,
    ),
    TOOL_REQUEST_MAX_WIDTH,
  )
}

/** Separator handlers that resize the inspector within its split. */
export interface DetailsResizeHandlers {
  onDoubleClick: () => void
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

/** The widths the split renders with, and the handlers that resize them. */
interface DetailsResizeHandle {
  /** Inspector width in pixels, or null while it follows the split default. */
  detailsWidth: number | null
  /** Tool-request offset in pixels, or null while the split default applies. */
  toolRequestOffset: number | null
  /** Handlers for the separator element. */
  handlers: DetailsResizeHandlers
}

/**
 * Track the inspector width and the tool-request offset it implies while the split separator is
 * dragged or nudged with the arrow keys. Double-clicking the separator drops both back to the
 * split default.
 *
 * The handlers read the separator's ancestors: its parent is the inspector, whose width they
 * resize, and its grandparent is the split container whose width bounds that resizing.
 * @returns The current widths and the separator handlers.
 */
export function useResizeHandle(): DetailsResizeHandle {
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null)
  const [toolRequestOffset, setToolRequestOffset] = useState<number | null>(null)
  const detailsResizeDrag = useRef<DetailsResizeDrag | null>(null)

  const handlers: DetailsResizeHandlers = {
    onDoubleClick: () => {
      setDetailsWidth(null)
      setToolRequestOffset(null)
    },
    onPointerDown: (event) => {
      if (event.button !== 0) return
      const details = event.currentTarget.parentElement
      if (details === null) return
      const split = details.parentElement
      if (split === null) return
      const splitWidth = split.getBoundingClientRect().width
      detailsResizeDrag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: details.getBoundingClientRect().width,
        splitWidth,
        startToolRequestOffset: toolRequestOffset ?? (
          splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
        ),
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    onPointerMove: (event) => {
      const drag = detailsResizeDrag.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const nextDetailsWidth = clampDetailsWidth(
        drag.startWidth + drag.startX - event.clientX,
        drag.splitWidth,
      )
      setDetailsWidth(nextDetailsWidth)
      setToolRequestOffset(
        drag.startToolRequestOffset
        + (nextDetailsWidth - drag.startWidth) * TOOL_REQUEST_SHARE,
      )
    },
    onPointerUp: (event) => {
      if (detailsResizeDrag.current?.pointerId !== event.pointerId) return
      detailsResizeDrag.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
    },
    onPointerCancel: () => {
      detailsResizeDrag.current = null
    },
    onKeyDown: (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const details = event.currentTarget.parentElement
      if (details === null) return
      const split = details.parentElement
      if (split === null) return
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      const currentDetailsWidth = details.getBoundingClientRect().width
      const splitWidth = split.getBoundingClientRect().width
      const nextDetailsWidth = clampDetailsWidth(
        currentDetailsWidth + direction * DETAILS_RESIZE_STEP,
        splitWidth,
      )
      const currentToolRequestOffset = toolRequestOffset ?? (
        splitWidth * TOOL_REQUEST_SHARE - defaultToolRequestWidth(splitWidth)
      )
      setDetailsWidth(nextDetailsWidth)
      setToolRequestOffset(
        currentToolRequestOffset
        + (nextDetailsWidth - currentDetailsWidth) * TOOL_REQUEST_SHARE,
      )
      event.preventDefault()
    },
  }

  return { detailsWidth, toolRequestOffset, handlers }
}
