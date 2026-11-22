/**
 * Durability primitives behind {@link writeFileAtomic}: flush a file's content
 * before its rename commits, then flush the parent directory's entry order.
 * @module Durability primitives for atomic file replacement
 */

import { open } from 'node:fs/promises'

/**
 * Flush one regular file's content to storage, so a crash never leaves the
 * rename target holding an empty or partial replacement.
 * @param path - the file to flush; the caller owns write access to it.
 */
export async function syncFileDurably(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Best-effort durability ordering for a directory entry: fsync the directory
 * so a completed rename survives a crash. Windows cannot open a directory
 * handle at all, and a refused fsync must not fail a write whose rename
 * already committed, so every failure resolves as a skip.
 * @param path - the directory whose entry ordering to flush.
 */
export async function syncDirectoryDurably(path: string): Promise<void> {
  try {
    await syncDirectoryHandle(path)
  } catch (error) {
    // Best-effort by contract: the caller's content is already renamed into
    // place, so a skipped or refused directory fsync fails nothing — Windows
    // cannot open directory handles, and no caller can retry a directory
    // fsync meaningfully after the rename committed.
    void error
  }
}

/**
 * Open the directory, flush its entry ordering, and close the handle.
 * @param path - the directory whose entry ordering to flush.
 */
async function syncDirectoryHandle(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
