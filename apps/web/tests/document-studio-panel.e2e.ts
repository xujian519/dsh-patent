// Web e2e scenario: the fixed Deliverables conversation view over the real web
// composition. No model call is involved — the seeded session log carries the
// working drafts a document turn writes, then one `document_deliver`
// registration, and the assertion chain is the whole delivery path: log replay
// → session history → Conversation Node fold → the `documentDeliverables` view
// snapshot behind the Deliverables tab → the preview read of a produced file
// through the session's `workspaceFiles` Remote. The tab is activated by its
// slot id, so this guards the slot-id-equals-target contract: a mismatched id
// leaves the target unactivated and the view stuck on its empty state, which is
// exactly the regression this scenario rejects.
//
// The later cases exercise the live preview: the `file` resource's version
// refreshes the pane after an on-disk rewrite, following selects the newest
// draft, pausing automatic refresh holds the old content until the reload
// action, and the configured inline-HTML cap hands a large file to the sidebar.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/document-studio-panel/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/document-studio-panel', import.meta.url))
const STUDIO_EXPECTED = join(SNAPSHOT_DIR, 'studio.expected.md')
const OVERLAY = fileURLToPath(new URL('./document-studio-panel.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'document-studio-panel-web-e2e'

// The registration and working-draft log names these paths; the preview reads
// their bytes from the Session workspace, so the scenario writes the same
// paths there before the page loads.
const CLAIMS_HTML = '<!doctype html><h1>CLAIMS_FIXTURE</h1>'
const SPECIFICATION_MD = '# SPECIFICATION_FIXTURE\n\nDelivered claims, as text.'
const BRIEF_MD = '# Brief\n\nGoal: a delivery fixture.\n'
const OUTLINE_MD = '# Outline\n\n## Intro\n\n## Body\n'
const CHAPTER_ONE = '## Intro\n\nOpening chapter.\n'
const CHAPTER_TWO = '## Body\n\nSecond chapter.\n'
const BIG_HTML = `<!doctype html><h1>BIG_FIXTURE</h1>${'x'.repeat(2000)}`

describe.skipIf(MODE === 'record')('web e2e: document studio Deliverables view', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    const cwd = scaffold.workspaceCwd
    await writeFile(join(cwd, 'claims.html'), CLAIMS_HTML)
    await writeFile(join(cwd, 'specification.md'), SPECIFICATION_MD)
    await writeFile(join(cwd, 'brief.md'), BRIEF_MD)
    await writeFile(join(cwd, 'outline.md'), OUTLINE_MD)
    await mkdir(join(cwd, 'chapters'), { recursive: true })
    await writeFile(join(cwd, 'chapters', '01-intro.md'), CHAPTER_ONE)
    await writeFile(join(cwd, 'chapters', '02-body.md'), CHAPTER_TWO)
    await writeFile(join(cwd, 'big.html'), BIG_HTML)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Open the Deliverables tab and wait for the folded list. */
  async function openStudio(): Promise<void> {
    await page.getByRole('tab', { name: 'Deliverables' }).click()
    await page.locator('[data-document-deliverables-list]').waitFor({ timeout: 15_000 })
  }

  it('renders the delivered files and the working drafts behind the fixed Deliverables tab', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-view'))
    await openStudio()
    const list = page.locator('[data-document-deliverables-list]')
    for (const path of ['specification.md', 'claims.html', 'brief.md', 'outline.md', 'big.html']) {
      await list.locator(`[data-document-deliverable="${path}"]`).waitFor({ timeout: 10_000 })
    }
    // A working draft below a subdirectory is listed too: nothing registers it.
    await list.locator('[data-document-deliverable="chapters/02-body.md"]').waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[data-document-deliverables-list]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(STUDIO_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'studio.expected.md'])
  })

  it('follows the newest produced draft and renders Markdown as typeset text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-follow'))
    await openStudio()
    // Following is on by default; the last working draft written is chapter 02.
    await page.getByRole('heading', { name: 'Body', level: 2 }).waitFor({ timeout: 15_000 })
    expect(await page.getByText('Opening chapter.', { exact: false }).count()).toBe(0)
    // Picking another file pauses following, visible on the toggle.
    await page.locator('[data-document-deliverable="brief.md"]').click()
    await page.getByRole('heading', { name: 'Brief', level: 1 }).waitFor({ timeout: 15_000 })
    expect(await page.getByRole('button', { name: 'Follow latest' }).getAttribute('aria-pressed')).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('previews a produced file through the session workspace read', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-preview'))
    await openStudio()
    const list = page.locator('[data-document-deliverables-list]')
    // HTML renders in the sandboxed frame, whose document is the host read.
    await list.locator('[data-document-deliverable="claims.html"]').click()
    const frame = page.locator('iframe[title="claims.html"]')
    await expect.poll(() => frame.getAttribute('srcdoc'), { timeout: 15_000 }).toContain('CLAIMS_FIXTURE')
    expect(await frame.getAttribute('sandbox')).toBe('')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refreshes the open file when the disk copy is rewritten', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-refresh'))
    await openStudio()
    await page.locator('[data-document-deliverable="chapters/02-body.md"]').click()
    await page.getByRole('heading', { name: 'Body', level: 2 }).waitFor({ timeout: 15_000 })
    const revised = '## Body\n\nSecond chapter, revised in place.\n'
    await writeFile(join(scaffold.workspaceCwd, 'chapters', '02-body.md'), revised)
    await page.getByText('Second chapter, revised in place.', { exact: false }).waitFor({ timeout: 15_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('holds the preview while automatic refresh is paused and reloads on demand', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-pause'))
    await openStudio()
    await page.locator('[data-document-deliverable="chapters/02-body.md"]').click()
    const toggle = page.getByRole('button', { name: 'Auto-refresh' })
    await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('true')
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('false')
    const paused = '## Body\n\nSecond chapter, written while paused.\n'
    await writeFile(join(scaffold.workspaceCwd, 'chapters', '02-body.md'), paused)
    await page.waitForTimeout(600)
    expect(await page.getByText('written while paused', { exact: false }).count()).toBe(0)
    await page.getByRole('button', { name: 'Reload' }).click()
    await page.getByText('written while paused', { exact: false }).waitFor({ timeout: 15_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('hands an HTML file above the configured cap to the sidebar instead of a frame', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-document-studio-cap'))
    await openStudio()
    await page.locator('[data-document-deliverable="big.html"]').click()
    await page.getByText('File exceeds 1.0KB', { exact: false }).waitFor({ timeout: 15_000 })
    expect(await page.locator('iframe[title="big.html"]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
