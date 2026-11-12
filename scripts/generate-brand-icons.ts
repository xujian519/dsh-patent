/**
 * Regenerate every binary brand icon from the recorded SVG mark sources.
 *
 * The binaries under `apps/web/public` and `apps/desktop/assets` are build
 * products, not hand-maintained artwork: a rebase that touches them must be
 * able to rebuild them from `brand/assets/` in one command. Each raster comes
 * from the mark source whose stroke weight suits its size — the 6u standard
 * above 32 px, the 8u small variant below — because scaling one down to 16 px
 * leaves the hook tips too thin to read.
 *
 * Requires `rsvg-convert`, `magick`, and `iconutil` on PATH; missing tools fail
 * loudly instead of emitting a partial icon set.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const markDir = join(root, 'brand/assets')
const webPublic = join(root, 'apps/web/public')
const desktopAssets = join(root, 'apps/desktop/assets')

/** Ink and accent used by the light and dark favicon pair. */
const LIGHT_INK = '#0F1115'
const LIGHT_ACCENT = '#4D6BFE'
const DARK_INK = '#FFFFFF'
const DARK_ACCENT = '#7AAAFF'

/**
 * Transparent margin Apple's macOS icon template reserves on each side of a
 * 1024px canvas. The Dock sizes icons by their full canvas, so a background
 * box filling all 1024px reads about a quarter larger than neighbouring apps.
 */
export const MACOS_ICON_CANVAS_INSET = 100 / 1024

/** One app-icon tile: square canvas, rounded background, inset mark. */
export interface TileSpec {
  /** Raster size in pixels. */
  size: number
  /** Top-left background colour. */
  from: string
  /** Bottom-right background colour. */
  to: string
  /** Mark stroke ink. */
  ink: string
  /** Mark hook accent. */
  accent: string
  /** Mark inset as a fraction of the background box, per side. */
  inset: number
  /** Transparent margin around the background box as a fraction of the canvas, per side. */
  canvasInset: number
}

/** Pixel geometry of one tile. */
export interface TileGeometry {
  /** Transparent margin around the background box, per side. */
  canvasInset: number
  /** Background rounded-rectangle edge length. */
  box: number
  /** Mark inset inside the background box, per side. */
  markInset: number
  /** Mark drawing edge length. */
  inner: number
  /** Background corner radius. */
  radius: number
}

/**
 * Resolve a tile's pixel geometry.
 * @param spec - tile geometry and palette.
 * @returns the canvas margin, background box, and mark placement in pixels.
 */
export function tileGeometry(spec: TileSpec): TileGeometry {
  const canvasInset = spec.size * spec.canvasInset
  const box = spec.size - canvasInset * 2
  const markInset = box * spec.inset
  return {
    canvasInset,
    box,
    markInset,
    inner: box - markInset * 2,
    radius: box * 0.2237,
  }
}

/**
 * Read one recorded mark source and return its inner drawing, so a tile can
 * embed the authoritative geometry instead of restating it.
 * @param name - mark file name under brand/assets.
 * @returns the SVG body between the root element and its closing tag.
 */
function markBody(name: string): string {
  const source = readFileSync(join(markDir, name), 'utf8')
  return source.replace(/^[\s\S]*?<svg[^>]*>/u, '').replace(/<\/svg>[\s\S]*$/u, '')
}

/** Recolour a monochrome-currentColor mark body for a specific tile. */
function recoloured(body: string, ink: string, accent: string): string {
  // The mono source paints every stroke with currentColor; assign roles in path order:
  // the first two paths are the left hook, the last two the right hook.
  let index = 0
  return body.replaceAll('currentColor', () => (index++ < 2 ? ink : accent))
}

/**
 * Build one app-icon SVG document.
 * @param spec - tile geometry and palette.
 * @returns standalone SVG text.
 */
function tile(spec: TileSpec): string {
  const body = recoloured(markBody('mark-mono.svg'), spec.ink, spec.accent)
  const { canvasInset, box, markInset, inner, radius } = tileGeometry(spec)
  const origin = canvasInset + markInset
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.size}" height="${spec.size}" viewBox="0 0 ${spec.size} ${spec.size}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${spec.from}"/><stop offset="1" stop-color="${spec.to}"/>
  </linearGradient></defs>
  <rect x="${pixels(canvasInset)}" y="${pixels(canvasInset)}" width="${pixels(box)}" height="${pixels(box)}" rx="${pixels(radius)}" ry="${pixels(radius)}" fill="url(#bg)"/>
  <g transform="translate(${pixels(origin)},${pixels(origin)}) scale(${(inner / 64).toFixed(6)})">${body}</g>
</svg>`
}

/** Format a pixel value without trailing float noise. */
function pixels(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** A named SVG document and its raster size. */
interface RasterJob {
  /** Output file name, extension included. */
  out: string
  /** Destination directory. */
  dir: string
  /** SVG source text. */
  svg: string
  /** Raster width in pixels (height follows the square canvas). */
  width: number
}

/**
 * Build a favicon document. Browsers draw favicons at 16–32 px, so these use
 * the small variant: its thicker stroke survives downscaling, while the
 * standard 6u source thins out below 32 px.
 */
function faviconSvg(ink: string, accent: string): string {
  const body = recoloured(markBody('mark-small.svg'), ink, accent)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none">${body}</svg>`
}

/**
 * List every icon raster the repository ships.
 * @returns the job list in emission order.
 */
export function brandJobs(): RasterJob[] {
  return [
    // Favicons keep the mark's own aspect on a transparent canvas.
    { out: 'favicon.svg', dir: webPublic, svg: faviconSvg(LIGHT_INK, LIGHT_ACCENT), width: 0 },
    { out: 'favicon-dark.svg', dir: webPublic, svg: faviconSvg(DARK_INK, DARK_ACCENT), width: 0 },
    { out: 'favicon.svg', dir: join(root, 'website/public'), svg: faviconSvg(LIGHT_INK, LIGHT_ACCENT), width: 0 },

    // PWA + touch icons: white tile, standard mark.
    ...([
      ['icon-192.png', 192, 0.115],
      ['icon-512.png', 512, 0.115],
      ['apple-touch-icon.png', 180, 0.115],
      // Maskable keeps an 80% safe circle: a larger inset survives every crop.
      ['icon-maskable-512.png', 512, 0.21],
    ] as const).map(([out, size, inset]) => ({
      out,
      dir: webPublic,
      svg: tile({ size, from: '#FFFFFF', to: '#EEF2FA', ink: LIGHT_INK, accent: LIGHT_ACCENT, inset, canvasInset: 0 }),
      width: size,
    })),

    // Desktop application icon (source PNG; .icns/.ico derive from it below).
    {
      out: 'icon.png',
      dir: desktopAssets,
      svg: tile({
        size: 1024,
        from: '#FFFFFF',
        to: '#EEF2FA',
        ink: LIGHT_INK,
        accent: LIGHT_ACCENT,
        inset: 0.115,
        canvasInset: MACOS_ICON_CANVAS_INSET,
      }),
      width: 1024,
    },

    // Tray template icons are monochrome: macOS tints them, so colour is meaningless.
    ...[
      ['trayTemplate.png', 22],
      ['trayTemplate@2x.png', 44],
      ['tray.png', 44],
    ].map(([out, size]) => ({
      out: out as string,
      dir: desktopAssets,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" fill="none">${markBody('mark-tray.svg').replaceAll('currentColor', '#000000')}</svg>`,
      width: size as number,
    })),
  ]
}

/** Render one SVG job through rsvg-convert, or write it verbatim when width is 0. */
function emit(job: RasterJob): void {
  const svgPath = join(job.dir, `.${job.out}.tmp.svg`)
  writeFileSync(svgPath, job.svg)
  const target = join(job.dir, job.out)
  if (job.width === 0) {
    writeFileSync(target, job.svg)
  } else {
    execFileSync('rsvg-convert', ['-w', String(job.width), '-h', String(job.width), '-o', target, svgPath])
  }
  rmSync(svgPath, { force: true })
}

/** One ICNS representation: the file name iconutil expects and its raster size. */
export interface IcnsEntry {
  /** File name inside the .iconset directory. */
  file: string
  /** Square raster size in pixels. */
  pixels: number
}

/**
 * List the representations of the macOS .icns bundle. iconutil reads base
 * sizes and their @2x pairs only, so plain 64x64 or 1024x1024 file names are
 * dropped from the bundle instead of failing.
 * @returns the iconset entries in ascending pixel size.
 */
export function icnsEntries(): IcnsEntry[] {
  return [
    { file: 'icon_16x16.png', pixels: 16 },
    { file: 'icon_16x16@2x.png', pixels: 32 },
    { file: 'icon_32x32.png', pixels: 32 },
    { file: 'icon_32x32@2x.png', pixels: 64 },
    { file: 'icon_128x128.png', pixels: 128 },
    { file: 'icon_128x128@2x.png', pixels: 256 },
    { file: 'icon_256x256.png', pixels: 256 },
    { file: 'icon_256x256@2x.png', pixels: 512 },
    { file: 'icon_512x512.png', pixels: 512 },
    { file: 'icon_512x512@2x.png', pixels: 1024 },
  ]
}

/**
 * Assemble the macOS .icns bundle from the freshly rendered 1024px source.
 * @param source - absolute path to the 1024px PNG.
 * @param target - absolute .icns path.
 */
function buildIcns(source: string, target: string): void {
  const set = join(desktopAssets, '.icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  for (const entry of icnsEntries()) {
    execFileSync('magick', [source, '-resize', `${entry.pixels}x${entry.pixels}`, join(set, entry.file)])
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', target])
  rmSync(set, { recursive: true, force: true })
}

/**
 * Assemble the Windows .ico from the same source.
 * @param source - absolute path to the 1024px PNG.
 * @param target - absolute .ico path.
 */
function buildIco(source: string, target: string): void {
  execFileSync('magick', [source, '-define', 'icon:auto-resize=256,128,64,48,32,16', target])
}

function main(): number {
  const jobs = brandJobs()
  for (const job of jobs) emit(job)
  buildIcns(join(desktopAssets, 'icon.png'), join(desktopAssets, 'icon.icns'))
  buildIco(join(desktopAssets, 'icon.png'), join(desktopAssets, 'icon.ico'))
  console.log(`generate-brand-icons: ${jobs.length} raster job(s) emitted, icon.icns and icon.ico rebuilt.`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main())
}
