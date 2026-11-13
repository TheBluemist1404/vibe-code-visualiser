// Bounded, non-blocking file reads shared by the store and the repository layer.
//
// Callers keep their own checks (lstat before open, fstat on the descriptor, their error
// messages); these helpers only fix the open flags and the read loop, so every reader stops at
// the same byte budget and none blocks on a FIFO.
import { constants, readSync } from "node:fs";

/** open(2) flags for reading: read-only, and never blocking on a FIFO. */
export const OPEN_READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
/** OPEN_READ, and never through a final symlink (where the OS has O_NOFOLLOW). */
export const OPEN_READ_NOFOLLOW = OPEN_READ | (constants.O_NOFOLLOW ?? 0);

/**
 * Reads an open file from its current position until EOF or until `max + 1` bytes, whichever
 * comes first. A result longer than `max` means the file holds more than `max` bytes.
 */
export function readUpTo(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max + 1);
  let n = 0;
  while (n < buf.length) {
    const read = readSync(fd, buf, n, buf.length - n, null);
    if (read === 0) break;
    n += read;
  }
  return buf.subarray(0, n);
}

/** Reads an open file in chunks of `size` bytes until EOF, or until `onChunk` returns false. */
export function readChunks(fd: number, size: number, onChunk: (chunk: Buffer) => boolean | undefined): void {
  const buf = Buffer.alloc(size);
  for (;;) {
    const read = readSync(fd, buf, 0, size, null);
    if (read === 0 || onChunk(buf.subarray(0, read)) === false) return;
  }
}
