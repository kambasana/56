/**
 * Size of an npm tarball's contents, for versions the registry has no `dist.unpackedSize` /
 * `dist.fileCount` for (npm publish has recorded them since 2018; older versions lack them).
 *
 * Computed as npm publish computes them (npm/cli lib/utils/tar.js `getContents`): the sum of the
 * entries' sizes, and the number of entries. Only the tar headers are read (ustar, 512-byte blocks;
 * pax `size` records honoured); file contents are skipped, never interpreted. Untrusted input:
 * the decompressed size is capped and any malformed header stops the read with an error.
 */
import { gunzipSync } from 'node:zlib';

/** Tarballs larger than this once decompressed are not read (never a small package). */
export const MAX_UNPACKED_TARBALL = 64 * 1024 * 1024;

export interface TarballFootprint {
  unpackedSize: number;
  fileCount: number;
}

function octal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len);
  // GNU base-256 encoding (high bit set) is for sizes > 8 GB: never a small package.
  if (raw[0]! & 0x80) throw new Error('tar: base-256 size');
  const s = raw.toString('latin1').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error('tar: malformed size field');
  return Number.parseInt(s, 8);
}

/** pax extended header records ("<len> key=value\n"): the `size` override, if any. */
function paxSize(data: Buffer): number | undefined {
  const text = data.toString('utf8');
  const m = /(?:^|\n)\d+ size=(\d+)\n/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function tarballFootprint(gz: Buffer, maxUnpacked = MAX_UNPACKED_TARBALL): TarballFootprint {
  const tar = gunzipSync(gz, { maxOutputLength: maxUnpacked });
  let off = 0;
  let unpackedSize = 0;
  let fileCount = 0;
  let nextSize: number | undefined;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const type = String.fromCharCode(header[156]!);
    const meta = type === 'x' || type === 'g' || type === 'L' || type === 'K';
    let size = octal(header, 124, 12);
    if (!meta && nextSize !== undefined) size = nextSize;
    off += 512;
    const dataEnd = off + size;
    if (dataEnd > tar.length) throw new Error('tar: entry runs past the end of the archive');
    if (type === 'x' || type === 'g') {
      // pax header: applies to the next entry ('x') or globally ('g'); not an entry itself.
      if (type === 'x') nextSize = paxSize(tar.subarray(off, dataEnd));
    } else if (type === 'L' || type === 'K') {
      // GNU long name / link name: metadata for the next entry.
    } else {
      nextSize = undefined;
      // node-tar counts every entry (npm packs files only; old tarballs may carry directories of size 0).
      if (type !== '5') fileCount++;
      unpackedSize += size;
    }
    off += Math.ceil((dataEnd - off) / 512) * 512;
  }
  return { unpackedSize, fileCount };
}
