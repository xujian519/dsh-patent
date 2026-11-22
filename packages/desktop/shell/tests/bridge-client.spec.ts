/**
 * Tests for the desktop-shell JSON-RPC bridge client.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, BridgeRpcError, type JsonRpcNotification } from '../src/bridge-client.ts'

// Windows cannot listen on a POSIX socket file; a named pipe is the native form.
// The path is unique PER TEST: Windows pipe names linger briefly after the
// owning server closes, so a fixed name collides with the previous test's
// (EADDRINUSE) while the OS frees it.
let socketPath: string
let socketPathCounter = 0
function nextSocketPath(): string {
  socketPathCounter += 1
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-desktop-bridge-test-${process.pid}-${socketPathCounter}`
    : join(tmpdir(), `dsh-desktop-bridge-test-${process.pid}-${socketPathCounter}.sock`)
}

describe('BridgeClient', () => {
  let server: Server
  let serverSocket: Socket | undefined
  let client: BridgeClient
  let notifications: JsonRpcNotification[] = []
  let closeCount = 0

  beforeEach(async () => {
    notifications = []
    closeCount = 0
    serverSocket = undefined
    socketPath = nextSocketPath()
    server = createServer((socket) => {
      serverSocket = socket
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as { id: number; method: string; params?: unknown }
          if ('id' in frame) {
            if (frame.method === 'never-answered') return
            const response = frame.method === 'echo'
              ? { jsonrpc: '2.0', id: frame.id, result: frame.params }
              : { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `unknown: ${frame.method}` } }
            socket.write(JSON.stringify(response) + '\n')
          }
        }
      })
    })
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
    client = new BridgeClient({
      path: socketPath,
      onNotification: (notification) => { notifications.push(notification) },
      onClose: () => { closeCount += 1 },
      // The close-oriented tests below own the socket lifecycle; a reconnecting
      // client would open fresh connections mid-test. Reconnect is exercised
      // in its own describe block with a dedicated construction.
      reconnect: { retries: 0 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  afterEach(async () => {
    client.dispose()
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
    try { unlinkSync(socketPath) } catch (error) {
      // Node unlinks the socket when the server closes; the removal is best-effort.
      void error
    }
  })

  it('calls a method and resolves the result', async () => {
    const result = await client.call('echo', { hello: 'world' })
    expect(result).toEqual({ hello: 'world' })
  })

  it('rejects with a BridgeRpcError when the server returns an error', async () => {
    await expect(client.call('unknown', {})).rejects.toMatchObject({
      name: 'BridgeRpcError',
      code: -32601,
      message: 'unknown: unknown',
    })
  })

  it('sends notifications without expecting a response', () => {
    client.notify('ping', { value: 1 })
    // No response is requested, so the client should not hang.
    expect(client.connected).toBe(true)
  })

  it('reports disconnected after disposal', () => {
    client.dispose()
    expect(client.connected).toBe(false)
  })

  it('rejects a pending call with AbortError when the signal aborts', async () => {
    const controller = new AbortController()
    const promise = client.call('never-answered', {}, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('aborted')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(client.call('echo', {}, controller.signal)).rejects.toThrow('aborted')
  })

  it('detaches the abort listener once the call settles', async () => {
    const controller = new AbortController()
    const result = await client.call('echo', { done: true }, controller.signal)
    expect(result).toEqual({ done: true })
    // Aborting after settlement must not surface an error on the settled call.
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
  })

  it('settles a pending call when the synchronous write throws', async () => {
    const socket = (client as unknown as { socket: Socket }).socket
    const failure = new Error('write EPIPE')
    const original = socket.write.bind(socket)
    socket.write = () => { throw failure }
    try {
      const promise = client.call('echo', { value: 1 })
      await expect(promise).rejects.toBe(failure)
    } finally {
      socket.write = original
    }
    // The failed write must not leave a pending entry behind.
    const pending = (client as unknown as { pending: Map<number, unknown> }).pending
    expect(pending.size).toBe(0)
    // The client stays usable for the next call on the healthy socket.
    await expect(client.call('echo', { after: true })).resolves.toEqual({ after: true })
  })

  it('wraps a non-Error synchronous write failure before rejecting the call', async () => {
    const socket = (client as unknown as { socket: Socket }).socket
    const original = socket.write.bind(socket)
    socket.write = () => { throw 'write EPIPE' }
    try {
      const failure = await client.call('echo', { value: 1 }).then(
        () => undefined,
        (error: unknown) => error,
      )
      // The caller awaits an Error; a primitive throw must not reach it raw.
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe('write EPIPE')
    } finally {
      socket.write = original
    }
  })

  it('rejects pending calls and reports close when the server ends the socket', async () => {
    const promise = client.call('never-answered', {})
    serverSocket?.end()
    await expect(promise).rejects.toThrow('bridge socket closed')
    expect(closeCount).toBe(1)
  })

  it('does not report a close after an explicit dispose', async () => {
    client.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closeCount).toBe(0)
  })

  it('rejects calls after disposal', async () => {
    client.dispose()
    await expect(client.call('echo', {})).rejects.toThrow('bridge client is disposed')
  })

  it('parses a server-pushed notification', async () => {
    serverSocket?.write(JSON.stringify({ jsonrpc: '2.0', method: 'desktop/tray-clicked', params: { button: 'left' } }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notifications).toEqual([
      { jsonrpc: '2.0', method: 'desktop/tray-clicked', params: { button: 'left' } },
    ])
  })

  it('exports BridgeRpcError for provider mapping', () => {
    expect(new BridgeRpcError(-32000, 'boom').code).toBe(-32000)
  })

  it('drops notifications after disposal', () => {
    client.dispose()
    expect(() => {
      client.notify('ping', {})
    }).not.toThrow()
  })

  it('drops notifications while the socket is not connected', async () => {
    serverSocket?.end()
    await expect.poll(() => client.connected).toBe(false)
    expect(() => {
      client.notify('ping', {})
    }).not.toThrow()
  })

  it('rejects calls after the server closes the socket', async () => {
    serverSocket?.end()
    await expect.poll(() => client.connected).toBe(false)
    await expect(client.call('echo', {})).rejects.toThrow('bridge socket is not connected')
  })

  it('rejects pending calls and reports close when the connection is refused', async () => {
    const deadPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-desktop-bridge-dead-${process.pid}`
      : join(tmpdir(), `dsh-desktop-bridge-dead-${process.pid}.sock`)
    const orphan = new BridgeClient({
      path: deadPath,
      onNotification: () => {},
      onClose: () => { closeCount += 1 },
    })
    try {
      // The connect fails: onError rejects nothing pending (there is none),
      // then the close surfaces as a bridge loss.
      await expect.poll(() => closeCount).toBe(1)
      expect(orphan.connected).toBe(false)
    } finally {
      orphan.dispose()
    }
  })

  it('skips empty lines in the frame stream', async () => {
    serverSocket?.write(
      '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'desktop/tray-clicked', params: { button: 'right' } }) + '\n',
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notifications).toHaveLength(1)
  })

  it('ignores a malformed frame', async () => {
    serverSocket?.write('not-json\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notifications).toEqual([])
  })

  it('ignores a response for an unknown id', async () => {
    serverSocket?.write(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notifications).toEqual([])
  })

  it('ignores a frame without an id or method', async () => {
    serverSocket?.write(JSON.stringify({ jsonrpc: '2.0' }) + '\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notifications).toEqual([])
  })
})

describe('BridgeClient reconnect', () => {
  let server: Server
  let serverSocket: Socket | undefined
  let client: BridgeClient
  let reconnects = 0

  beforeEach(async () => {
    reconnects = 0
    serverSocket = undefined
    socketPath = nextSocketPath()
    server = createServer((socket) => {
      serverSocket = socket
      socket.setEncoding('utf8')
      socket.on('data', () => {})
    })
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
  })

  afterEach(async () => {
    client.dispose()
    serverSocket?.end()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err != null) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    }
    try { unlinkSync(socketPath) } catch (error) {
      // Node unlinks the socket when the server closes; the removal is best-effort.
      void error
    }
  })

  it('rejects pending calls when the socket errors after connecting', async () => {
    client = new BridgeClient({
      path: socketPath,
      onNotification: () => {},
      onClose: () => {},
      reconnect: { retries: 5, baseDelayMs: 10, maxDelayMs: 20 },
      onReconnect: () => { reconnects += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(client.connected).toBe(true)
    const pending = client.call('desktop/probe', {}).catch((error: unknown) => error)
    const reset = new Error('reset')
    ;(client as unknown as { socket: { emit: (event: string, error: Error) => void } }).socket.emit('error', reset)
    const error = await pending
    expect(error).toBe(reset)
  })

  it('stops scheduling reconnects when disposed mid-flight', async () => {
    client = new BridgeClient({
      path: socketPath,
      onNotification: () => {},
      onClose: () => {},
      reconnect: { retries: 5, baseDelayMs: 10, maxDelayMs: 20 },
      onReconnect: () => { reconnects += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(client.connected).toBe(true)
    client.dispose()
    // An in-flight retry socket's close handler reaches scheduleReconnect
    // after dispose; it must not arm another connection.
    const connect = vi.spyOn(client as unknown as { connect: (initial: boolean) => void }, 'connect')
    ;(client as unknown as { scheduleReconnect: () => void }).scheduleReconnect()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(connect).not.toHaveBeenCalled()
  })

  it('reconnects after an unexpected close and fires onReconnect', async () => {
    client = new BridgeClient({
      path: socketPath,
      onNotification: () => {},
      onClose: () => {},
      reconnect: { retries: 5, baseDelayMs: 10, maxDelayMs: 20 },
      onReconnect: () => { reconnects += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(client.connected).toBe(true)
    serverSocket?.end()
    await expect.poll(() => reconnects, { timeout: 5_000 }).toBe(1)
    expect(client.connected).toBe(true)
  })

  it('gives up after the retry budget when the peer stays down', async () => {
    client = new BridgeClient({
      path: socketPath,
      onNotification: () => {},
      onClose: () => {},
      reconnect: { retries: 2, baseDelayMs: 10, maxDelayMs: 20 },
      onReconnect: () => { reconnects += 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    // Take the server down entirely: every reconnect attempt is refused.
    serverSocket?.end()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err != null) reject(err)
        else resolve()
      })
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(reconnects).toBe(0)
    expect(client.connected).toBe(false)
  })

  it('recovers a first-connect refusal once the peer starts listening', async () => {
    // A fresh path with no listener yet: the constructor's connect is refused,
    // and the backoff retry must recover a Main that was still starting.
    const latePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-desktop-bridge-late-${process.pid}`
      : join(tmpdir(), `dsh-desktop-bridge-late-${process.pid}.sock`)
    let initialClose = 0
    client = new BridgeClient({
      path: latePath,
      onNotification: () => {},
      onClose: () => { initialClose += 1 },
      reconnect: { retries: 10, baseDelayMs: 10, maxDelayMs: 20 },
      onReconnect: () => { reconnects += 1 },
    })
    // Wait for the refusal before starting the server, so the recovery is
    // exercised by a retry and not by the initial connect winning the race.
    await expect.poll(() => initialClose, { timeout: 5_000 }).toBe(1)
    const late = createServer(() => {})
    await new Promise<void>((resolve, reject) => {
      late.on('error', reject)
      late.listen(latePath, resolve)
    })
    await expect.poll(() => reconnects, { timeout: 5_000 }).toBe(1)
    expect(client.connected).toBe(true)
    // Disconnect before closing the server: server.close waits for live
    // connections, and the reconnected client is still attached.
    client.dispose()
    await new Promise<void>((resolve, reject) => {
      late.close((error) => {
        if (error != null) reject(error)
        else resolve()
      })
    })
    try { unlinkSync(latePath) } catch (error) {
      // Node unlinks the socket when the server closes; the removal is best-effort.
      void error
    }
  })
})
