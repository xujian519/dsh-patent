/**
 * 绘图工具拒绝的位图扩展名。读照片走 `analyze_patent_figure`；绘制要结构化几何或 CAD 模型。
 * @module @deepseek-ai/dsh-patent-tools/figure/raster-input
 */

import { extname } from 'node:path'

/** 小写扩展名，含点。大小写不敏感的比较在 {@link rasterFigureExtension}。 */
export const RASTER_FIGURE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.bmp'] as const

/**
 * @param path - 文件路径或文件名。
 * @returns 是位图时返回小写扩展名（含点）；否则返回 undefined。
 */
export function rasterFigureExtension(path: string): string | undefined {
  const ext = extname(path).toLowerCase()
  return (RASTER_FIGURE_EXTENSIONS as readonly string[]).includes(ext) ? ext : undefined
}

/**
 * @param field - 报错里的字段名。
 * @param ext - 位图扩展名，含点。
 * @returns 指向 `analyze_patent_figure` 的说明。调用方套自己的错误类型。
 */
export function rasterFigureMessage(field: string, ext: string): string {
  return `${field} 是位图（${ext}），本工具不从像素推断轮廓。读图用 analyze_patent_figure；确认零件名与坐标或 CAD 模型后再绘制。`
}
