/**
 * Tests for the Electron Main JSON-RPC bridge server: socket lifecycle,
 * method allow-listing, and startup failure all run without an Electron host.
 */

import { connect, createServer, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, Tray } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeServer, resolveBridgePath } from '../src/bridge-server.ts'

/** Hoisted fake state shared by the mocked electron module and the tests. */
const mocks = vi.hoisted(() => ({
  notifications: [] as {
    options: Record<string, string | undefined>
    handlers: Record<string, () => void>
    show: ReturnType<typeof vi.fn>
  }[],
  lastMenuTemplate: [] as unknown[],
  buildFromTemplate: vi.fn(),
  setApplicationMenu: vi.fn(),
  registerShortcut: vi.fn(),
  unregisterAll: vi.fn(),
  isNotificationSupported: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true, filePath: '' }),
  },
  Menu: {
    buildFromTemplate: mocks.buildFromTemplate.mockImplementation((template: unknown[]) => {
      mocks.lastMenuTemplate = template
      return { template }
    }),
    setApplicationMenu: mocks.setApplicationMenu,
  },
  Notification: Object.assign(
    vi.fn().mockImplementation(function (this: unknown, options: Record<string, string | undefined>) {
      const instance = {
        options,
        handlers: {} as Record<string, () => void>,
        show: vi.fn(),
        on: vi.fn((event: string, cb: () => void) => {
          instance.handlers[event] = cb
          return instance
        }),
      }
      mocks.notifications.push(instance)
      return instance
    }),
    { isSupported: mocks.isNotificationSupported.mockReturnValue(true) },
  ),
  globalShortcut: {
    register: mocks.registerShortcut.mockReturnValue(true),
    unregister: vi.fn(),
    unregisterAll: mocks.unregisterAll,
  },
}))

const window = {} as BrowserWindow
const APP_NAME = 'DeepSeek Harness'
// Windows cannot listen on a POSIX socket file; a named pipe is the native form.
// The path is unique PER TEST: Windows pipe names linger briefly after the
// owning server closes, so a fixed name collides with the previous test's
// (EADDRINUSE) while the OS frees it.
let socketPath: string
let socketPathCounter = 0
function nextSocketPath(): string {
  socketPathCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-desktop-bridge-server-test-${process.pid}-${socketPathCounter}`
    : join(tmpdir(), `dsh-desktop-bridge-server-test-${process.pid}-${socketPathCounter}.sock`)
}

/** One JSON-RPC line the bridge wrote back to the backend. */
interface Frame {
  jsonrpc: '2.0'
  id?: number
  method?: string
  result?: unknown
  error?: { code: number; message: string }
  params?: unknown
}

/** A shell-owned tray double handed to the bridge through initTray. */
function makeTrayDouble(): {
  tray: Tray
  handlers: Record<string, () => void>
  setToolTip: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
} {
  const setToolTip = vi.fn()
  const setContextMenu = vi.fn()
  const destroy = vi.fn()
  const handlers: Record<string, () => void> = {}
  const tray = {
    setToolTip,
    setContextMenu,
    destroy,
    on: vi.fn((event: string, cb: () => void) => { handlers[event] = cb }),
  } as unknown as Tray
  return { tray, handlers, setToolTip, setContextMenu, destroy }
}

const APP_MENU_BASE: Electron.MenuItemConstructorOptions[] = [
  { label: APP_NAME, submenu: [{ role: 'quit' }] },
]

describe('resolveBridgePath', () => {
  it('resolves a pid-suffixed POSIX socket in the OS temp directory', () => {
    expect(resolveBridgePath('darwin')).toBe(join(tmpdir(), `dsh-desktop-bridge-${process.pid}.sock`))
    expect(resolveBridgePath('linux')).toBe(join(tmpdir(), `dsh-desktop-bridge-${process.pid}.sock`))
  })

  it('resolves a Windows named pipe carrying the pid', () => {
    expect(resolveBridgePath('win32')).toBe(`\\\\?\\pipe\\dsh-desktop-bridge-${process.pid}`)
  })
})

describe('BridgeServer', () => {
  let bridge: BridgeServer
  let client: Socket | undefined
  let frames: string[] = []

  /**
   * Wait for the frame `match` accepts and return it parsed. Real socket
   * delivery replaces the fixed sleeps this suite used to park on: a loaded
   * runner can deliver a response after any fixed delay, and the failure names
   * the frames that did arrive instead of a bare timeout.
   * @param match - predicate the awaited frame must satisfy.
   * @returns the parsed frame.
   */
  async function waitForFrame(match: (frame: Frame) => boolean): Promise<Frame> {
    return vi.waitFor(() => {
      const parsed = frames.map(line => JSON.parse(line) as Frame)
      const found = parsed.find(match)
      if (found === undefined) throw new Error(`the bridge wrote no matching frame among ${JSON.stringify(parsed)}`)
      return found
    }, { timeout: 5_000, interval: 5 })
  }

  beforeEach(async () => {
    frames = []
    mocks.notifications.length = 0
    mocks.lastMenuTemplate = []
    mocks.buildFromTemplate.mockClear()
    mocks.setApplicationMenu.mockClear()
    mocks.registerShortcut.mockClear().mockReturnValue(true)
    mocks.unregisterAll.mockClear()
    mocks.isNotificationSupported.mockClear().mockReturnValue(true)
    socketPath = nextSocketPath()
    bridge = new BridgeServer(() => window, APP_NAME)
    await bridge.start(socketPath)
    client = connect(socketPath)
    client.setEncoding('utf8')
    client.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) frames.push(line)
    })
    // Readiness handshake: the bridge attaches its backend socket inside the
    // accept callback, so only a completed round-trip proves that a later
    // notify() push reaches this client. `unregisterGlobalShortcut` is
    // allow-listed and owns no state; its frame is dropped so each case starts
    // at index 0.
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'desktop/unregisterGlobalShortcut', params: { accelerator: 'Cmd+K' } }) + '\n')
    await waitForFrame(frame => frame.id === 0)
    frames.length = 0
  })

  afterEach(async () => {
    client?.end()
    bridge.dispose()
    // Node unlinks a POSIX socket file when the closing server releases it —
    // every observed run reported ENOENT on the first attempt — and a Windows
    // pipe name is not a file at all, so this stays a best-effort removal
    // rather than a wait for the file to disappear.
    try { unlinkSync(socketPath) } catch (error) {
      // Node unlinks the socket when the closing server releases it; this is best-effort.
      void error
    }
  })

  it('rejects an unknown method with a JSON-RPC error', async () => {
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'desktop/unknown' }) + '\n')
    const frame = await waitForFrame(candidate => candidate.id === 1)
    expect(frame.error?.code).toBe(-32601)
  })

  it('rejects a frame without an id', async () => {
    client?.write(JSON.stringify({ jsonrpc: '2.0', method: 'desktop/unknown' }) + '\n')
    // A frame with no id gets no reply, and an absence has no event to await.
    // The valid frame behind it supplies that event: the bridge answers in
    // request order, so a reply to the id-less frame would have to precede the
    // id 1 response and this would see two frames.
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'desktop/unknown' }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    expect(frames).toHaveLength(1)
  })

  it('rejects a second connection while one backend is attached', async () => {
    const second = connect(socketPath)
    const closed = new Promise<void>((resolve) => { second.on('close', () => { resolve() }) })
    await closed
    expect(second.destroyed).toBe(true)
  })

  it('rejects start when the socket path is already taken', async () => {
    bridge.dispose()
    // A FRESH path: the beforeEach bridge's name may still be held on Windows
    // while its pipe tears down, which would make the blocker's own listen
    // fail instead of the second BridgeServer's.
    const occupied = nextSocketPath()
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.on('error', reject)
      blocker.listen(occupied, resolve)
    })
    const other = new BridgeServer(() => window, APP_NAME)
    await expect(other.start(occupied)).rejects.toThrow()
    other.dispose()
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error != null) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  })

  it('recovers from a stale socket file with no live listener', async () => {
    bridge.dispose()
    if (process.platform === 'win32') return // named pipes leave no file behind
    await new Promise<void>((resolve, reject) => {
      const stale = createServer()
      stale.on('error', reject)
      stale.listen(socketPath, () => {
        stale.close(() => {
          // POSIX keeps the socket file after close: a stale file with no
          // listener is exactly the crashed-app residue a restart must clear.
          resolve()
        })
      })
    })
    const other = new BridgeServer(() => window, APP_NAME)
    await other.start(socketPath)
    other.dispose()
  })

  it('disposes without failing when never started', () => {
    const fresh = new BridgeServer(() => window, APP_NAME)
    fresh.dispose()
  })

  it('delivers a notification and pushes its click back with the id', async () => {
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/sendNotification', params: { title: 'hello', body: 'world' },
    }) + '\n')
    const response = await waitForFrame(candidate => candidate.id === 1)
    expect(response.result).toEqual({ delivered: true, notificationId: 'notification-1' })
    expect(mocks.notifications).toHaveLength(1)
    expect(mocks.notifications[0]?.options).toEqual({ title: 'hello', body: 'world' })
    frames.length = 0
    mocks.notifications[0]?.handlers.click?.()
    const pushed = await waitForFrame(candidate => candidate.method === 'desktop/notification-clicked')
    expect(pushed.params).toEqual({ notificationId: 'notification-1' })
  })

  it('reports undelivered when notifications are unsupported', async () => {
    mocks.isNotificationSupported.mockReturnValue(false)
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'desktop/sendNotification', params: { title: 'x' } }) + '\n')
    const response = await waitForFrame(candidate => candidate.id === 1)
    expect(response.result).toEqual({ delivered: false })
  })

  it('registers a menu item behind the shell base entries and pushes its activation', async () => {
    bridge.setAppMenuBase(APP_MENU_BASE)
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/registerMenuItem',
      params: { group: 'file', item: { id: 'open', label: 'Open', accelerator: 'CmdOrCtrl+O' } },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    // One rebuild from setAppMenuBase, one from the registration.
    expect(mocks.setApplicationMenu).toHaveBeenCalledTimes(2)
    // The shell's own entries survive the rebuild; the group follows them.
    expect(mocks.lastMenuTemplate[0]).toMatchObject({ label: APP_NAME })
    const group = mocks.lastMenuTemplate.find(entry =>
      typeof entry === 'object' && entry !== null && (entry as { label?: string }).label === 'file') as { submenu: { click: () => void }[] } | undefined
    expect(group?.submenu).toHaveLength(1)
    frames.length = 0
    group?.submenu[0]?.click?.()
    const pushed = await waitForFrame(candidate => candidate.method === 'desktop/menu-activated')
    expect(pushed.params).toEqual({ menuId: 'open' })
  })

  it('restores the base application menu when the last group is removed', async () => {
    bridge.setAppMenuBase(APP_MENU_BASE)
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/registerMenuItem',
      params: { group: 'file', item: { id: 'open', label: 'Open' } },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    // Base rebuild + registration rebuild.
    expect(mocks.setApplicationMenu).toHaveBeenCalledTimes(2)
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'desktop/unregisterMenuItem',
      params: { group: 'file', id: 'open' },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 2)
    // Removing the last group must reinstall the shell's base menu, not leave
    // the custom menu with a stale group standing.
    expect(mocks.setApplicationMenu).toHaveBeenCalledTimes(3)
    expect(mocks.lastMenuTemplate.some((entry) => {
      const candidate = entry as { label?: string }
      return candidate.label === 'file'
    })).toBe(false)
  })

  it('registers a global shortcut and pushes its trigger', async () => {
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/registerGlobalShortcut', params: { accelerator: 'Cmd+K' },
    }) + '\n')
    const response = await waitForFrame(candidate => candidate.id === 1)
    expect(response.result).toEqual({ ok: true })
    const callback = mocks.registerShortcut.mock.calls[0]?.[1] as (() => void) | undefined
    frames.length = 0
    callback?.()
    const pushed = await waitForFrame(candidate => candidate.method === 'desktop/shortcut-triggered')
    expect(pushed.params).toEqual({ accelerator: 'Cmd+K' })
  })

  it('rejects a shortcut registration the OS cannot claim', async () => {
    mocks.registerShortcut.mockReturnValue(false)
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/registerGlobalShortcut', params: { accelerator: 'Cmd+K' },
    }) + '\n')
    const response = await waitForFrame(candidate => candidate.id === 1)
    expect(response.error?.code).toBe(-32000)
    expect(response.error?.message).toContain('already registered')
  })

  it.each([
    'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Z',
    'CmdOrCtrl+Shift+Z', 'Ctrl+V', 'Control+Alt+C',
    // Multi-modifier stacks and the Windows traditional editing keys must
    // also be refused; a narrower pattern would let a plugin claim them.
    'Cmd+Shift+Alt+C', 'Super+V', 'Meta+X',
    'Ctrl+Insert', 'Shift+Insert', 'Shift+Delete',
  ])(
    'rejects %s as a reserved editing accelerator',
    async (accelerator) => {
      client?.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'desktop/registerGlobalShortcut', params: { accelerator },
      }) + '\n')
      const response = await waitForFrame(candidate => candidate.id === 1)
      expect(response.error?.code).toBe(-32000)
      expect(response.error?.message).toContain('reserved for system editing')
      // The refusal must land before any OS-side claim: otherwise a plugin
      // could still steal Cmd+C system-wide and only fail afterwards.
      expect(mocks.registerShortcut).not.toHaveBeenCalled()
    },
  )

  it.each(['Shift+C', 'Alt+F4', 'Cmd+K', 'Ctrl+P', 'F5', 'Insert'])(
    'accepts %s because it is not a reserved editing accelerator',
    async (accelerator) => {
      // Guard against an over-broad pattern: Shift+C is just an uppercase C,
      // Alt+F4 / Cmd+K / Ctrl+P / F5 are window or plugin bindings, and a
      // bare Insert with no modifier is not a clipboard operation.
      client?.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'desktop/registerGlobalShortcut', params: { accelerator },
      }) + '\n')
      const response = await waitForFrame(candidate => candidate.id === 1)
      expect(response.result).toEqual({ ok: true })
      expect(mocks.registerShortcut).toHaveBeenCalledWith(accelerator, expect.any(Function))
    },
  )

  it('sets the tray tooltip and menu group through setTray', async () => {
    const double = makeTrayDouble()
    bridge.initTray(double.tray, { onShow: () => {}, onQuit: () => {} })
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/setTray', params: { tooltip: 'DSH', menuGroup: 'tray' },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    expect(double.setToolTip).toHaveBeenCalledWith('DSH')
    // A tray-group menu item lands in the tray menu, not the application menu.
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'desktop/registerMenuItem',
      params: { group: 'tray', item: { id: 'pause', label: 'Pause' } },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 2)
    // A tray-group item never joins the application menu; the rebuild still
    // runs (base baseline) but must not carry the tray item. Read the
    // application menu from the setApplicationMenu call, not the shared mock
    // capture: the tray rebuild's own buildFromTemplate overwrites that.
    const appMenu = mocks.setApplicationMenu.mock.calls.at(-1)?.[0] as { template?: unknown[] } | undefined
    expect(appMenu?.template?.some((entry) => {
      const candidate = entry as { label?: string }
      return candidate.label === 'Pause'
    })).toBe(false)
    const trayMenu = double.setContextMenu.mock.calls.at(-1)?.[0] as { template?: unknown[] } | undefined
    expect(trayMenu?.template?.some(entry =>
      typeof entry === 'object' && entry !== null && (entry as { label?: string }).label === 'Pause')).toBe(true)
  })

  it('clears the tray configuration back to the default tooltip', async () => {
    const double = makeTrayDouble()
    bridge.initTray(double.tray, { onShow: () => {}, onQuit: () => {} })
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'desktop/setTray', params: { tooltip: 'DSH' } }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    client?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'desktop/clearTray' }) + '\n')
    await waitForFrame(candidate => candidate.id === 2)
    expect(double.setToolTip).toHaveBeenLastCalledWith(APP_NAME)
  })

  it('labels the tray base entries with the app name', async () => {
    const double = makeTrayDouble()
    bridge.initTray(double.tray, { onShow: () => {}, onQuit: () => {} })
    const trayMenu = double.setContextMenu.mock.calls.at(-1)?.[0] as { template?: { label?: string }[] } | undefined
    const labels = (trayMenu?.template ?? []).map(entry => entry.label)
    expect(labels).toContain(`Show ${APP_NAME}`)
    expect(labels).toContain(`Quit ${APP_NAME}`)
  })

  it('pushes tray clicks to the backend', async () => {
    const double = makeTrayDouble()
    bridge.initTray(double.tray, { onShow: () => {}, onQuit: () => {} })
    frames.length = 0
    double.handlers.click?.()
    const pushed = await waitForFrame(candidate => candidate.method === 'desktop/tray-clicked')
    expect(pushed.params).toEqual({ button: 'left' })
  })

  it('dispose tears down shortcuts and the socket but leaves the tray to the shell', async () => {
    const double = makeTrayDouble()
    bridge.initTray(double.tray, { onShow: () => {}, onQuit: () => {} })
    client?.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'desktop/sendNotification', params: { title: 'x' },
    }) + '\n')
    await waitForFrame(candidate => candidate.id === 1)
    bridge.dispose()
    expect(mocks.unregisterAll).toHaveBeenCalled()
    expect(double.destroy).not.toHaveBeenCalled()
  })
})
