/**
 * JSON-RPC bridge server running in the Electron main process. The dsh backend
 * connects over a local socket and calls OS-level methods here; OS events are
 * pushed back to the backend through the same channel.
 */

import { connect, createServer, type Server, type Socket } from 'node:net'
import { readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BrowserWindow,
  dialog, globalShortcut, Menu, Notification, type Tray,
} from 'electron'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Incoming JSON-RPC request from the backend. */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

/** Outgoing JSON-RPC response to the backend. */
interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/** Outgoing JSON-RPC notification to the backend. */
interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** One registered menu item as it travels over the wire. */
interface WireMenuItem {
  id: string
  label: string
  accelerator?: string
}

/** Base tray entries supplied by the shell owner (main.ts). */
interface TrayBaseActions {
  /** Restore and focus the main window. */
  onShow: () => void
  /** Begin an explicit quit. */
  onQuit: () => void
}

/** Allow-listed bridge methods implemented by the main process. */
const ALLOWED_METHODS = new Set([
  'desktop/showOpenDialog',
  'desktop/showSaveDialog',
  'desktop/sendNotification',
  'desktop/registerMenuItem',
  'desktop/unregisterMenuItem',
  'desktop/registerGlobalShortcut',
  'desktop/unregisterGlobalShortcut',
  'desktop/setTray',
  'desktop/clearTray',
] as const)

/** Every allow-listed bridge method; `dispatch` is total over this union. */
type DesktopBridgeMethod = Parameters<typeof ALLOWED_METHODS.has>[0]

/** Whether a JSON-RPC method name is one this bridge implements. */
function isDesktopBridgeMethod(method: string): method is DesktopBridgeMethod {
  // Membership is a string question; the widening keeps the predicate's own
  // parameter type out of the answer.
  return (ALLOWED_METHODS as ReadonlySet<string>).has(method)
}

/** The default tray menu group, overridable through the setTray params. */
const DEFAULT_TRAY_GROUP = 'tray'

/** Filename prefix shared by every bridge socket in the OS temp directory. */
const BRIDGE_SOCKET_PREFIX = 'dsh-desktop-bridge-'

/**
 * Accelerators that own the platform editing surface. `globalShortcut.register`
 * claims its binding system-wide — Chromium in every other application loses
 * the accelerator too — so the bridge refuses them at the earliest point it
 * sees the string, before any OS-side claim exists to unwind.
 *
 * Two branches, because the two key families have different modifier rules:
 * - Letter bindings (copy, paste, cut, select-all, undo) require a primary
 *   Cmd/Ctrl/Super/Meta modifier; `Shift+C` alone is just an uppercase C and
 *   must stay available to plugins.
 * - Windows traditional editing keys (Insert for copy/paste, Delete for cut)
 *   are meaningful under Shift alone (`Shift+Insert` pastes, `Shift+Delete`
 *   cuts), so any modifier stack qualifies.
 *
 * Other editing keys — arrows, Home/End, function keys — are not claimed
 * system-wide by the shell menu and stay out of this list.
 */
const RESERVED_LETTER_ACCELERATOR_PATTERN =
  /^(?:CmdOrCtrl|Cmd|Command|Ctrl|Control|Super|Meta)(?:\+(?:Shift|Alt|Option|Super|Meta))*\+[CVXAZ]$/iu
const RESERVED_TRADITIONAL_EDIT_KEY_PATTERN =
  /^(?:(?:CmdOrCtrl|Cmd|Command|Ctrl|Control|Shift|Alt|Option|Super|Meta)\+)+(?:Insert|Delete)$/iu

/**
 * Whether an accelerator string matches one of the reserved editing bindings.
 * @param accelerator - Electron accelerator string supplied by a backend caller.
 * @returns true when the bridge must refuse the registration.
 */
function isReservedAccelerator(accelerator: string): boolean {
  return (
    RESERVED_LETTER_ACCELERATOR_PATTERN.test(accelerator) ||
    RESERVED_TRADITIONAL_EDIT_KEY_PATTERN.test(accelerator)
  )
}

/**
 * Resolve a bridge socket path. Windows uses a named pipe carrying the pid;
 * POSIX uses a Unix domain socket in the OS temp directory, also named per
 * pid. A repo-nested userData directory would exceed the ~104-byte Unix
 * socket path cap in development (EINVAL), so the temp directory is the one
 * location that stays short for every layout.
 * @param platform - target platform, defaulting to the current one.
 * @returns the bridge path to pass to the backend as DSH_DESKTOP_BRIDGE_PATH.
 */
export function resolveBridgePath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `\\\\?\\pipe\\${BRIDGE_SOCKET_PREFIX}${process.pid}`
    : join(tmpdir(), `${BRIDGE_SOCKET_PREFIX}${process.pid}.sock`)
}

/**
 * Remove bridge sockets left by dead processes. A pid-suffixed socket is
 * never rebound by a later launch, so residue would accumulate; unlinking is
 * best-effort and cannot remove another user's file in a sticky directory.
 */
export function removeStaleBridgeSockets(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(BRIDGE_SOCKET_PREFIX) || !entry.endsWith('.sock')) continue
    if (entry === `${BRIDGE_SOCKET_PREFIX}${process.pid}.sock`) continue
    try {
      unlinkSync(join(tmpdir(), entry))
    } catch {
      // Another user's file or an already-removed entry: leave it alone.
    }
  }
}

/**
 * Bridge server owned by Electron Main. It creates the socket before the dsh
 * backend is spawned, accepts one backend connection, and dispatches allow-listed
 * JSON-RPC methods to Electron APIs. Menu, tray, shortcut, and notification
 * state all live here so backend registrations and OS events share one model.
 * The Tray instance is created by the shell and handed over via {@link initTray};
 * the bridge only customizes its tooltip and context menu.
 */
export class BridgeServer {
  private server: Server | undefined = undefined
  private socket: Socket | undefined = undefined
  private buffer = ''
  private readonly menuGroups = new Map<string, Map<string, WireMenuItem>>()
  private tray: Tray | undefined = undefined
  private trayBaseActions: TrayBaseActions | undefined = undefined
  private trayMenuGroup = DEFAULT_TRAY_GROUP
  private appMenuBase: Electron.MenuItemConstructorOptions[] = []
  private readonly notifications = new Map<string, Notification>()
  private notificationSeq = 0

  /**
   * @param anchorWindow - resolves the window anchoring OS dialogs; the main
   * window may not exist yet when the bridge starts, so this is a getter.
   * @param appName - packaged product name used in tray menu copy.
   */
  constructor(
    private readonly anchorWindow: () => BrowserWindow | undefined,
    private readonly appName: string,
  ) {}

  /**
   * Register the shell-owned application menu entries. Rebuilds triggered by
   * backend menu groups keep these entries ahead of the registered groups.
   * @param template - the shell's own application menu template.
   */
  setAppMenuBase(template: Electron.MenuItemConstructorOptions[]): void {
    this.appMenuBase = template
    this.rebuildAppMenu()
  }

  /**
   * Create the socket server and wait for it to listen.
   * @param path - socket path or pipe name.
   * @returns a promise that resolves once listening.
   */
  async start(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        if (this.socket !== undefined) {
          // Reject the extra backend connection. Its errors are expected
          // (e.g. a reset during the FIN exchange) and must not crash Main.
          socket.on('error', () => {})
          socket.end()
          return
        }
        this.socket = socket
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => { this.onData(chunk) })
        socket.on('close', () => { this.socket = undefined })
        socket.on('error', (error) => { console.error('desktop bridge socket error', error) })
      })
      let staleRetried = false
      this.server.on('error', (error) => {
        // A POSIX socket file survives its listener: a crashed or killed app
        // leaves `path` behind, and a fresh bind then fails with EADDRINUSE
        // even though nothing listens. Probe the path — a live listener keeps
        // the error; a dead file is unlinked and the bind retried once.
        if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE' && path.startsWith('/') && !staleRetried) {
          staleRetried = true
          const probe = connect(path)
          probe.once('connect', () => {
            probe.destroy()
            reject(error)
          })
          probe.once('error', () => {
            probe.destroy()
            rmSync(path, { force: true })
            this.server?.listen(path)
          })
          return
        }
        reject(error)
      })
      this.server.listen(path, () => { resolve() })
    })
  }

  /**
   * Hand the shell-owned tray to the bridge so backend registrations can join
   * its context menu. The bridge never creates or destroys the tray; it only
   * adds click notifications and customizes the tooltip and context menu.
   * @param tray - the tray instance created by main.ts.
   * @param actions - the base menu entries owned by the shell.
   */
  initTray(tray: Tray, actions: TrayBaseActions): void {
    this.tray = tray
    this.trayBaseActions = actions
    tray.on('click', () => {
      this.notify('desktop/tray-clicked', { button: 'left' })
    })
    tray.on('right-click', () => {
      this.notify('desktop/tray-clicked', { button: 'right' })
    })
    this.rebuildTrayMenu()
  }

  /** Close the socket server, any active connection, and every OS registration. */
  dispose(): void {
    this.socket?.end()
    this.socket = undefined
    this.server?.close()
    this.server = undefined
    globalShortcut.unregisterAll()
    // The tray stays owned by main.ts, which destroys it on will-quit.
    this.tray = undefined
    this.trayBaseActions = undefined
    this.notifications.clear()
  }

  /** Send a one-way notification to the connected backend. */
  notify(method: string, params?: unknown): void {
    if (this.socket === undefined) return
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.socket.write(JSON.stringify(notification) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      this.onFrame(line).catch((error: unknown) => { console.error('desktop bridge frame error', error) })
    }
  }

  private async onFrame(line: string): Promise<void> {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch {
      // Ignore a malformed frame: the peer is our own backend process, and
      // one bad line must not kill the bridge.
      return
    }
    const id = request.id
    if (typeof id !== 'number') return
    const response = await this.handle(id, request)
    this.socket?.write(JSON.stringify(response) + '\n')
  }

  private async handle(id: number, request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const unknownMethod: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `unknown method: ${request.method}` },
    }
    if (!isDesktopBridgeMethod(request.method)) return unknownMethod
    try {
      const result = await this.dispatch(request.method, request.params)
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { jsonrpc: '2.0', id, error: { code: -32000, message } }
    }
  }

  private async dispatch(method: DesktopBridgeMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'desktop/showOpenDialog':
        return this.showOpenDialog(params)
      case 'desktop/showSaveDialog':
        return this.showSaveDialog(params)
      case 'desktop/sendNotification':
        return this.sendNotification(params)
      case 'desktop/registerMenuItem':
        this.registerMenuItem(params)
        return { ok: true }
      case 'desktop/unregisterMenuItem':
        this.unregisterMenuItem(params)
        return { ok: true }
      case 'desktop/registerGlobalShortcut':
        return this.registerGlobalShortcut(params)
      case 'desktop/unregisterGlobalShortcut':
        this.unregisterGlobalShortcut(params)
        return { ok: true }
      case 'desktop/setTray':
        this.setTray(params)
        return { ok: true }
      case 'desktop/clearTray':
        this.clearTray()
        return { ok: true }
      /* v8 ignore next -- closed-union backstop; the compiler rejects a new allow-listed method here. */
      default:
        return assertNever(method, 'desktop bridge method')
    }
  }

  private async showOpenDialog(params: unknown): Promise<{ filePaths: string[] } | undefined> {
    const { title, defaultPath, properties } = (params ?? {}) as { title?: string; defaultPath?: string; properties?: ('openFile' | 'openDirectory' | 'multiSelections')[] }
    const options: Electron.OpenDialogOptions = {}
    if (title !== undefined) options.title = title
    if (defaultPath !== undefined) options.defaultPath = defaultPath
    if (properties !== undefined) options.properties = properties
    const anchor = this.anchorWindow()
    const result = anchor === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(anchor, options)
    if (result.canceled) return undefined
    return { filePaths: result.filePaths }
  }

  private async showSaveDialog(params: unknown): Promise<{ filePath: string } | undefined> {
    const { title, defaultPath } = (params ?? {}) as { title?: string; defaultPath?: string }
    const options: Electron.SaveDialogOptions = {}
    if (title !== undefined) options.title = title
    if (defaultPath !== undefined) options.defaultPath = defaultPath
    const anchor = this.anchorWindow()
    const result = anchor === undefined
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(anchor, options)
    if (result.canceled) return undefined
    if (result.filePath === '') return undefined
    return { filePath: result.filePath }
  }

  private sendNotification(params: unknown): { delivered: boolean; notificationId?: string } {
    const { title, body, id } = (params ?? {}) as { title: string; body?: string; id?: string }
    if (!Notification.isSupported()) return { delivered: false }
    const notificationId = id ?? `notification-${++this.notificationSeq}`
    const notification = new Notification({
      title,
      ...body !== undefined ? { body } : {},
    })
    notification.on('click', () => {
      this.notifications.delete(notificationId)
      this.notify('desktop/notification-clicked', { notificationId })
    })
    notification.on('close', () => {
      this.notifications.delete(notificationId)
    })
    // Electron drops an unreferenced Notification; keep it until it closes.
    this.notifications.set(notificationId, notification)
    notification.show()
    return { delivered: true, notificationId }
  }

  private registerMenuItem(params: unknown): void {
    const { group, item } = (params ?? {}) as { group: string; item: WireMenuItem }
    let items = this.menuGroups.get(group)
    if (items === undefined) {
      items = new Map()
      this.menuGroups.set(group, items)
    }
    items.set(item.id, item)
    this.rebuildAppMenu()
    this.rebuildTrayMenu()
  }

  private unregisterMenuItem(params: unknown): void {
    const { group, id } = (params ?? {}) as { group: string; id: string }
    const items = this.menuGroups.get(group)
    items?.delete(id)
    // A group with no remaining items disappears from the model so rebuilds
    // never emit an empty submenu.
    if (items !== undefined && items.size === 0) this.menuGroups.delete(group)
    this.rebuildAppMenu()
    this.rebuildTrayMenu()
  }

  private registerGlobalShortcut(params: unknown): { ok: true } {
    const { accelerator } = (params ?? {}) as { accelerator: string }
    if (isReservedAccelerator(accelerator)) {
      throw new Error(`accelerator ${accelerator} is reserved for system editing`)
    }
    const registered = globalShortcut.register(accelerator, () => {
      this.notify('desktop/shortcut-triggered', { accelerator })
    })
    if (!registered) throw new Error(`accelerator ${accelerator} is already registered or unavailable`)
    return { ok: true }
  }

  private unregisterGlobalShortcut(params: unknown): void {
    const { accelerator } = (params ?? {}) as { accelerator: string }
    globalShortcut.unregister(accelerator)
  }

  private setTray(params: unknown): void {
    const { tooltip, menuGroup } = (params ?? {}) as { tooltip?: string; menuGroup?: string }
    if (this.tray === undefined) throw new Error('tray is unavailable')
    if (tooltip !== undefined) this.tray.setToolTip(tooltip)
    this.trayMenuGroup = menuGroup ?? DEFAULT_TRAY_GROUP
    this.rebuildTrayMenu()
  }

  private clearTray(): void {
    if (this.tray === undefined) return
    this.tray.setToolTip(this.appName)
    this.trayMenuGroup = DEFAULT_TRAY_GROUP
    this.rebuildTrayMenu()
  }

  /** One registered item as an Electron menu template entry. */
  private menuItemTemplate(item: WireMenuItem): Electron.MenuItemConstructorOptions {
    return {
      label: item.label,
      ...item.accelerator !== undefined ? { accelerator: item.accelerator } : {},
      click: () => { this.notify('desktop/menu-activated', { menuId: item.id }) },
    }
  }

  /** Rebuild the application menu: the shell's own entries plus one top-level menu per registered group. */
  private rebuildAppMenu(): void {
    const groups = [...this.menuGroups.entries()]
      .filter(([group, items]) => group !== this.trayMenuGroup && items.size > 0)
    const template: Electron.MenuItemConstructorOptions[] = [
      ...this.appMenuBase,
      ...groups.map(([group, items]) => ({
        label: group,
        submenu: [...items.values()].map(item => this.menuItemTemplate(item)),
      })),
    ]
    // Rebuild unconditionally: once a custom menu was installed, removing the
    // last group must restore the shell menu rather than leave the
    // stale custom one standing.
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  /** Rebuild the tray context menu: base entries plus the configured tray group. */
  private rebuildTrayMenu(): void {
    const tray = this.tray
    const actions = this.trayBaseActions
    if (tray === undefined || actions === undefined) return
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Show ${this.appName}`, click: actions.onShow },
      { type: 'separator' },
      { label: `Quit ${this.appName}`, click: actions.onQuit },
    ]
    const groupItems = this.menuGroups.get(this.trayMenuGroup)
    if (groupItems !== undefined && groupItems.size > 0) {
      template.push({ type: 'separator' })
      for (const item of groupItems.values()) template.push(this.menuItemTemplate(item))
    }
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }
}
