/**
 * Tests for the desktop-shell service provider.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DesktopError, MenuId } from '@deepseek-ai/dsh-desktop-seam'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DesktopShell, { BridgeClient } from '../src/index.ts'

// Windows cannot listen on a POSIX socket file; a named pipe is the native form.
// The path is unique PER TEST: Windows pipe names linger briefly after the
// owning server closes, so a fixed name collides with the previous test's
// (EADDRINUSE) while the OS frees it.
let socketPath: string
let socketPathCounter = 0
function nextSocketPath(): string {
  socketPathCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-desktop-shell-test-${process.pid}-${socketPathCounter}`
    : join(tmpdir(), `dsh-desktop-shell-test-${process.pid}-${socketPathCounter}.sock`)
}

describe('DesktopShell', () => {
  let server: Server
  let serverSocket: Socket | undefined
  let shells: { shell: DesktopShell; ctx: Context }[] = []
  let lastMethod: string | undefined
  let lastParams: unknown

  beforeEach(async () => {
    lastMethod = undefined
    lastParams = undefined
    serverSocket = undefined
    socketPath = nextSocketPath()
    server = createServer((socket) => {
      serverSocket = socket
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as { id?: number; method: string; params?: unknown }
          lastMethod = frame.method
          lastParams = frame.params
          if ('id' in frame && typeof frame.id === 'number') {
            const params = frame.params as { title?: string } | undefined
            const response = frame.method === 'desktop/showOpenDialog'
              ? params?.title === 'explode'
                ? { jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'boom' } }
                : { jsonrpc: '2.0', id: frame.id, result: { filePaths: ['/selected'] } }
              : frame.method === 'desktop/showSaveDialog'
                ? { jsonrpc: '2.0', id: frame.id, result: { filePath: '/saved.txt' } }
                : { jsonrpc: '2.0', id: frame.id, result: undefined }
            socket.write(JSON.stringify(response) + '\n')
          }
        }
      })
    })
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
    process.env.DSH_DESKTOP_BRIDGE_PATH = socketPath
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const { ctx } of shells) {
      await ctx.fiber.dispose()
    }
    shells = []
    serverSocket?.end()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err != null) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
    delete process.env.DSH_DESKTOP_BRIDGE_PATH
    try { unlinkSync(socketPath) } catch (error) {
      // Node unlinks the socket when the server closes; the removal is best-effort.
      void error
    }
  })

  it('showOpenDialog returns the selected paths', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    const result = await shell.showOpenDialog({ properties: ['openDirectory'] })
    expect(result).toEqual(['/selected'])
    expect(lastMethod).toBe('desktop/showOpenDialog')
  })

  it('showSaveDialog returns the selected path', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    const result = await shell.showSaveDialog({ defaultPath: '/tmp' })
    expect(result).toBe('/saved.txt')
    expect(lastMethod).toBe('desktop/showSaveDialog')
  })

  it('sendNotification forwards a notification', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    shell.sendNotification({ title: 'hello', body: 'world' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/sendNotification')
    expect(lastParams).toEqual({ title: 'hello', body: 'world' })
  })

  it('registerMenuItem and its disposer notify the bridge', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    const disposer = await shell.registerMenuItem('file', { id: MenuId('open'), label: 'Open' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/registerMenuItem')
    disposer()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/unregisterMenuItem')
  })

  it('registerGlobalShortcut and its disposer notify the bridge', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    const disposer = await shell.registerGlobalShortcut('Cmd+K', () => {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/registerGlobalShortcut')
    disposer()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/unregisterGlobalShortcut')
  })

  it('setTray and its disposer notify the bridge', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    const disposer = await shell.setTray({ tooltip: 'DSH' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/setTray')
    disposer()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/clearTray')
    // A second disposer call clears nothing further.
    disposer()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lastMethod).toBe('desktop/clearTray')
  })

  it('replays live registrations after a bridge reconnect', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await shell.registerMenuItem('tray', { id: MenuId('pause'), label: 'Pause' })
    await shell.registerGlobalShortcut('Cmd+P', () => {})
    // Drop the backend socket; the client reconnects (backoff 500ms base)
    // and re-sends every live registration in order.
    lastMethod = undefined
    serverSocket?.end()
    await expect.poll(() => lastMethod, { timeout: 5_000 }).toBe('desktop/registerGlobalShortcut')
    expect(await shell.showOpenDialog({})).toEqual(['/selected'])
  })

  it('replays a live tray registration after a bridge reconnect', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await shell.setTray({ tooltip: 'DSH' })
    lastMethod = undefined
    serverSocket?.end()
    await expect.poll(() => lastMethod, { timeout: 5_000 }).toBe('desktop/setTray')
  })

  it('logs a warning when reconnect replay fails', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    await shell.registerMenuItem('tray', { id: MenuId('pause'), label: 'Pause' })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const call = vi.spyOn(BridgeClient.prototype, 'call').mockRejectedValueOnce(new Error('replay boom'))
    serverSocket?.end()
    await expect.poll(() => warn.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0)
    expect(warn.mock.calls[0]?.[0]).toContain('replay boom')
    call.mockRestore()
  })

  it('logs a warning when replay rejects with a non-Error value', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 50))
    await shell.registerMenuItem('tray', { id: MenuId('pause'), label: 'Pause' })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const call = vi.spyOn(BridgeClient.prototype, 'call').mockRejectedValueOnce('plain failure')
    serverSocket?.end()
    await expect.poll(() => warn.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(0)
    expect(warn.mock.calls[0]?.[0]).toContain('plain failure')
    call.mockRestore()
  })

  it('rejects methods when the bridge path is missing', async () => {
    delete process.env.DSH_DESKTOP_BRIDGE_PATH
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await expect(shell.showOpenDialog({})).rejects.toThrow('DSH_DESKTOP_BRIDGE_PATH is not set')
  })

  it('maps a server JSON-RPC error to DesktopError(dialog-failed)', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(shell.showOpenDialog({ title: 'explode' })).rejects.toMatchObject({
      name: 'DesktopError',
      code: 'dialog-failed',
    })
  })

  it('propagates an aborted signal as AbortError, not a DesktopError', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    const controller = new AbortController()
    controller.abort()
    await expect(shell.showOpenDialog({}, controller.signal)).rejects.toThrow('aborted')
  })

  it('forwards desktop/menu-activated from the bridge to ctx listeners', async () => {
    const ctx = new Context()
    const received: string[] = []
    ctx.on('desktop/menu-activated', ({ menuId }) => { received.push(menuId) })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'desktop/menu-activated', params: { menuId: 'open' } }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toEqual(['open'])
  })

  it('invokes the registered shortcut handler when triggered', async () => {
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    let fired = 0
    await shell.registerGlobalShortcut('Cmd+K', () => { fired += 1 })
    serverSocket?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'desktop/shortcut-triggered', params: { accelerator: 'Cmd+K' } }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fired).toBe(1)
  })

  it('emits desktop/bridge-lost when the socket closes unexpectedly', async () => {
    const ctx = new Context()
    let lost = 0
    ctx.on('desktop/bridge-lost', () => { lost += 1 })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.end()
    // The FIN round-trip is slower on Windows; poll instead of a fixed wait.
    await expect.poll(() => lost, { timeout: 5_000 }).toBe(1)
  })

  it('does not emit desktop/bridge-lost when the shell is disposed normally', async () => {
    const ctx = new Context()
    let lost = 0
    ctx.on('desktop/bridge-lost', () => { lost += 1 })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lost).toBe(0)
  })

  it('rethrows a DesktopError from the bridge unchanged', async () => {
    vi.spyOn(BridgeClient.prototype, 'call').mockRejectedValue(
      new DesktopError('bridge-disconnected', 'nested failure'),
    )
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(shell.showOpenDialog({})).rejects.toMatchObject({
      name: 'DesktopError',
      code: 'bridge-disconnected',
      message: 'nested failure',
    })
  })

  it('maps a generic bridge failure to DesktopError(bridge-disconnected)', async () => {
    vi.spyOn(BridgeClient.prototype, 'call').mockRejectedValue(new Error('socket exploded'))
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(shell.showOpenDialog({})).rejects.toMatchObject({
      name: 'DesktopError',
      code: 'bridge-disconnected',
      message: 'socket exploded',
    })
  })

  it('maps a non-Error bridge rejection to DesktopError(bridge-disconnected)', async () => {
    vi.spyOn(BridgeClient.prototype, 'call').mockRejectedValue('plain rejection')
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(shell.showOpenDialog({})).rejects.toMatchObject({
      name: 'DesktopError',
      code: 'bridge-disconnected',
      message: 'plain rejection',
    })
  })

  it('rejects calls while the bridge socket is not connected', async () => {
    // A path with no listener: the connection attempt fails, so the bridge
    // never reaches `open` and every method reports bridge-disconnected.
    const orphanPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-desktop-shell-orphan-${process.pid}`
      : join(tmpdir(), `dsh-desktop-shell-orphan-${process.pid}.sock`)
    process.env.DSH_DESKTOP_BRIDGE_PATH = orphanPath
    const ctx = new Context()
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(shell.showOpenDialog({})).rejects.toThrow('desktop bridge socket is not connected')
  })

  it('forwards desktop/tray-clicked from the bridge to ctx listeners', async () => {
    const ctx = new Context()
    const received: string[] = []
    ctx.on('desktop/tray-clicked', ({ button }) => { received.push(button) })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'desktop/tray-clicked', params: { button: 'left' } }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toEqual(['left'])
  })

  it('forwards desktop/file-dropped from the bridge to ctx listeners', async () => {
    const ctx = new Context()
    const received: string[][] = []
    ctx.on('desktop/file-dropped', ({ paths }) => { received.push(paths) })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'desktop/file-dropped', params: { paths: ['/a', '/b'] } }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toEqual([['/a', '/b']])
  })

  it('forwards desktop/notification-clicked from the bridge to ctx listeners', async () => {
    const ctx = new Context()
    const received: string[] = []
    ctx.on('desktop/notification-clicked', ({ notificationId }) => { received.push(notificationId) })
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'desktop/notification-clicked',
        params: { notificationId: 'n-1' },
      }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toEqual(['n-1'])
  })

  it('warns and ignores an unknown bridge notification', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const shell = new DesktopShell(ctx)
    shells.push({ shell, ctx })
    await new Promise(resolve => setTimeout(resolve, 20))
    serverSocket?.write(JSON.stringify({ jsonrpc: '2.0', method: 'desktop/unknown-event' }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(warn).toHaveBeenCalledWith('unknown desktop bridge notification: desktop/unknown-event')
  })
})
