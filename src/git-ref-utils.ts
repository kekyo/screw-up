// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { open, readdir, readFile, stat, type FileHandle } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { inflateSync } from 'zlib';

//////////////////////////////////////////////////////////////////////////////////

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
type GitPackedObjectType = GitObjectType | 'ofs-delta' | 'ref-delta';

interface GitResolvedObject {
  oid: string;
  type: GitObjectType;
  content: Buffer;
}

interface GitPackIndex {
  fileHandle: FileHandle;
  objectByOid: Map<string, GitPackObjectLocation>;
  objectByOffset: Map<number, GitPackObjectLocation>;
}

interface GitPackObjectLocation {
  oid: string;
  offset: number;
  nextOffset: number;
  packIndex: GitPackIndex;
}

interface GitPackStore {
  packs: GitPackIndex[];
  objectByOid: Map<string, GitPackObjectLocation>;
}

interface GitObjectResolver {
  close: () => Promise<void>;
  readObject: (oid: string) => Promise<GitResolvedObject>;
  resolveTagOidToCommit: (tagOid: string) => Promise<string>;
}

interface GitPackedEntryHeader {
  packedType: GitPackedObjectType;
  declaredSize: number;
  headerLength: number;
  baseOffset: number | undefined;
  baseOid: string | undefined;
}

interface GitTreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const PACK_TRAILER_SIZE = 20;
const LOOSE_TAG_RESOLUTION_CONCURRENCY = 4;
const PACKED_OBJECT_TYPE_BY_CODE = new Map<number, GitPackedObjectType>([
  [1, 'commit'],
  [2, 'tree'],
  [3, 'blob'],
  [4, 'tag'],
  [6, 'ofs-delta'],
  [7, 'ref-delta'],
]);

//////////////////////////////////////////////////////////////////////////////////

/**
 * Resolve the actual Git directory for repositories, worktrees, and submodules.
 * @param repoPath - Repository path
 * @returns The resolved Git directory path
 */
export const getActualGitDir = async (repoPath: string): Promise<string> => {
  const gitDir = join(repoPath, '.git');
  const gitStat = await stat(gitDir).catch(() => null);

  if (!gitStat?.isFile()) {
    return gitDir;
  }

  const content = await readFile(gitDir, 'utf-8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    return gitDir;
  }

  return isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
};

const readFixedRange = async (
  fileHandle: FileHandle,
  offset: number,
  length: number
): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
  if (bytesRead !== length) {
    throw new Error(
      `Unexpected EOF while reading pack entry at offset ${offset} (expected ${length}, got ${bytesRead})`
    );
  }
  return buffer;
};

const readLooseObject = async (
  gitDir: string,
  oid: string
): Promise<GitResolvedObject | null> => {
  try {
    const deflated = await readFile(
      join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2))
    );
    const wrapped = inflateSync(deflated);
    const headerEnd = wrapped.indexOf(0);
    if (headerEnd < 0) {
      throw new Error(`Invalid loose object header: ${oid}`);
    }

    const header = wrapped.subarray(0, headerEnd).toString('utf-8');
    const match = header.match(/^(commit|tree|blob|tag) (\d+)$/);
    if (!match) {
      throw new Error(`Unsupported loose object header: ${header}`);
    }

    const content = wrapped.subarray(headerEnd + 1);
    const expectedSize = Number(match[2]);
    if (content.length !== expectedSize) {
      throw new Error(
        `Loose object size mismatch: ${oid} (expected ${expectedSize}, got ${content.length})`
      );
    }

    return {
      oid,
      type: match[1] as GitObjectType,
      content,
    };
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const readLargePackOffset = (
  idxBuffer: Buffer,
  largeOffsetsStart: number,
  largeOffsetIndex: number
): number => {
  const offset = Number(
    idxBuffer.readBigUInt64BE(largeOffsetsStart + largeOffsetIndex * 8)
  );
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`Pack offset exceeds safe integer range: ${offset}`);
  }
  return offset;
};

const loadPackIndex = async (idxPath: string): Promise<GitPackIndex> => {
  const packPath = idxPath.replace(/\.idx$/, '.pack');
  const [idxBuffer, packStat, fileHandle] = await Promise.all([
    readFile(idxPath),
    stat(packPath),
    open(packPath, 'r'),
  ]);

  if (idxBuffer.readUInt32BE(0) !== 0xff744f63) {
    throw new Error(`Unsupported pack index signature: ${idxPath}`);
  }
  if (idxBuffer.readUInt32BE(4) !== 2) {
    throw new Error(`Unsupported pack index version: ${idxPath}`);
  }

  const objectCount = idxBuffer.readUInt32BE(8 + 255 * 4);
  const oidStart = 8 + 256 * 4;
  const crcStart = oidStart + objectCount * 20;
  const offsetStart = crcStart + objectCount * 4;
  const largeOffsetStart = offsetStart + objectCount * 4;

  const objectByOid = new Map<string, GitPackObjectLocation>();
  const objectByOffset = new Map<number, GitPackObjectLocation>();
  const sortedObjects: Array<{ oid: string; offset: number }> = [];
  const packIndex: GitPackIndex = {
    fileHandle,
    objectByOid,
    objectByOffset,
  };

  for (let index = 0; index < objectCount; index++) {
    const oidOffset = oidStart + index * 20;
    const oid = idxBuffer.subarray(oidOffset, oidOffset + 20).toString('hex');
    const rawOffset = idxBuffer.readUInt32BE(offsetStart + index * 4);
    const offset =
      (rawOffset & 0x80000000) === 0
        ? rawOffset
        : readLargePackOffset(
            idxBuffer,
            largeOffsetStart,
            rawOffset & 0x7fffffff
          );

    sortedObjects.push({ oid, offset });
  }

  sortedObjects.sort((left, right) => left.offset - right.offset);

  const packEndOffset = packStat.size - PACK_TRAILER_SIZE;
  for (let index = 0; index < sortedObjects.length; index++) {
    const currentObject = sortedObjects[index];
    const nextOffset = sortedObjects[index + 1]?.offset ?? packEndOffset;
    const location: GitPackObjectLocation = {
      oid: currentObject.oid,
      offset: currentObject.offset,
      nextOffset,
      packIndex,
    };

    objectByOid.set(currentObject.oid, location);
    objectByOffset.set(currentObject.offset, location);
  }

  return packIndex;
};

const loadPackStore = async (gitDir: string): Promise<GitPackStore> => {
  try {
    const packDir = join(gitDir, 'objects', 'pack');
    const idxPaths = (await readdir(packDir))
      .filter((entryName) => entryName.endsWith('.idx'))
      .map((entryName) => join(packDir, entryName));
    const packs = await Promise.all(idxPaths.map(loadPackIndex));
    const objectByOid = new Map<string, GitPackObjectLocation>();

    for (const pack of packs) {
      for (const [oid, location] of pack.objectByOid.entries()) {
        objectByOid.set(oid, location);
      }
    }

    return { packs, objectByOid };
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return {
        packs: [],
        objectByOid: new Map<string, GitPackObjectLocation>(),
      };
    }
    throw error;
  }
};

const decodeOfsDeltaDistance = (
  buffer: Buffer,
  startOffset: number
): { distance: number; nextOffset: number } => {
  let cursor = startOffset;
  let byte = buffer[cursor++];
  let distance = byte & 0x7f;

  while (byte & 0x80) {
    byte = buffer[cursor++];
    distance = ((distance + 1) << 7) | (byte & 0x7f);
  }

  return { distance, nextOffset: cursor };
};

const parsePackedEntryHeader = (
  entryBuffer: Buffer,
  objectOffset: number
): GitPackedEntryHeader => {
  let cursor = 0;
  let byte = entryBuffer[cursor++];
  const packedType = PACKED_OBJECT_TYPE_BY_CODE.get((byte >> 4) & 0x7);
  if (!packedType) {
    throw new Error(`Unsupported packed object type at offset ${objectOffset}`);
  }

  let declaredSize = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = entryBuffer[cursor++];
    declaredSize |= (byte & 0x7f) << shift;
    shift += 7;
  }

  let baseOffset: number | undefined;
  let baseOid: string | undefined;
  if (packedType === 'ofs-delta') {
    const decoded = decodeOfsDeltaDistance(entryBuffer, cursor);
    cursor = decoded.nextOffset;
    baseOffset = objectOffset - decoded.distance;
  } else if (packedType === 'ref-delta') {
    baseOid = entryBuffer.subarray(cursor, cursor + 20).toString('hex');
    cursor += 20;
  }

  return {
    packedType,
    declaredSize,
    headerLength: cursor,
    baseOffset,
    baseOid,
  };
};

const readDeltaSize = (
  buffer: Buffer,
  startOffset: number
): { size: number; nextOffset: number } => {
  let cursor = startOffset;
  let size = 0;
  let shift = 0;

  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    size |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { size, nextOffset: cursor };
    }
    shift += 7;
  }

  throw new Error('Invalid git delta size encoding');
};

const applyGitDelta = (baseContent: Buffer, deltaContent: Buffer): Buffer => {
  const baseSizeInfo = readDeltaSize(deltaContent, 0);
  if (baseSizeInfo.size !== baseContent.length) {
    throw new Error(
      `Git delta base size mismatch: expected ${baseSizeInfo.size}, got ${baseContent.length}`
    );
  }

  const targetSizeInfo = readDeltaSize(deltaContent, baseSizeInfo.nextOffset);
  const result = Buffer.alloc(targetSizeInfo.size);

  let deltaOffset = targetSizeInfo.nextOffset;
  let resultOffset = 0;

  while (deltaOffset < deltaContent.length) {
    const opcode = deltaContent[deltaOffset++];

    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;

      if (opcode & 0x01) copyOffset |= deltaContent[deltaOffset++];
      if (opcode & 0x02) copyOffset |= deltaContent[deltaOffset++] << 8;
      if (opcode & 0x04) copyOffset |= deltaContent[deltaOffset++] << 16;
      if (opcode & 0x08) copyOffset |= deltaContent[deltaOffset++] << 24;
      if (opcode & 0x10) copySize |= deltaContent[deltaOffset++];
      if (opcode & 0x20) copySize |= deltaContent[deltaOffset++] << 8;
      if (opcode & 0x40) copySize |= deltaContent[deltaOffset++] << 16;
      if (copySize === 0) {
        copySize = 0x10000;
      }

      baseContent.copy(result, resultOffset, copyOffset, copyOffset + copySize);
      resultOffset += copySize;
      continue;
    }

    if (opcode === 0) {
      throw new Error('Invalid git delta opcode');
    }

    deltaContent.copy(result, resultOffset, deltaOffset, deltaOffset + opcode);
    deltaOffset += opcode;
    resultOffset += opcode;
  }

  if (resultOffset !== result.length) {
    throw new Error(
      `Git delta size mismatch: expected ${result.length}, got ${resultOffset}`
    );
  }

  return result;
};

const inflatePackedObject = (compressedContent: Buffer): Buffer =>
  Buffer.from(inflateSync(compressedContent));

const parseTagTargetOid = (tagContent: Buffer): string => {
  const firstLineEnd = tagContent.indexOf(0x0a);
  const firstLine =
    firstLineEnd >= 0
      ? tagContent.subarray(0, firstLineEnd).toString('utf-8')
      : tagContent.toString('utf-8');
  const match = firstLine.match(/^object ([0-9a-f]{40})$/);
  if (!match) {
    throw new Error(`Invalid annotated tag payload: ${firstLine}`);
  }
  return match[1];
};

const parseTreeEntries = (treeContent: Buffer): GitTreeEntry[] => {
  const entries: GitTreeEntry[] = [];
  let offset = 0;

  while (offset < treeContent.length) {
    const modeEnd = treeContent.indexOf(0x20, offset);
    if (modeEnd < 0) {
      throw new Error('Invalid tree entry mode');
    }

    const nameEnd = treeContent.indexOf(0x00, modeEnd + 1);
    if (nameEnd < 0 || nameEnd + 21 > treeContent.length) {
      throw new Error('Invalid tree entry name');
    }

    entries.push({
      mode: treeContent.subarray(offset, modeEnd).toString('utf-8'),
      name: treeContent.subarray(modeEnd + 1, nameEnd).toString('utf-8'),
      oid: treeContent.subarray(nameEnd + 1, nameEnd + 21).toString('hex'),
    });

    offset = nameEnd + 21;
  }

  return entries;
};

const createGitObjectResolver = async (
  repoPath: string
): Promise<GitObjectResolver> => {
  const actualGitDir = await getActualGitDir(repoPath);
  const resolvedObjects = new Map<string, Promise<GitResolvedObject>>();
  let packStorePromise: Promise<GitPackStore> | undefined;

  const getPackStore = async (): Promise<GitPackStore> => {
    if (!packStorePromise) {
      packStorePromise = loadPackStore(actualGitDir);
    }
    return packStorePromise;
  };

  const readPackedObject = async (
    location: GitPackObjectLocation
  ): Promise<GitResolvedObject> => {
    const entryLength = location.nextOffset - location.offset;
    const entryBuffer = await readFixedRange(
      location.packIndex.fileHandle,
      location.offset,
      entryLength
    );
    const header = parsePackedEntryHeader(entryBuffer, location.offset);
    const compressedContent = entryBuffer.subarray(header.headerLength);

    if (
      header.packedType === 'commit' ||
      header.packedType === 'tree' ||
      header.packedType === 'blob' ||
      header.packedType === 'tag'
    ) {
      const content = inflatePackedObject(compressedContent);
      if (content.length !== header.declaredSize) {
        throw new Error(
          `Packed object size mismatch: ${location.oid} (expected ${header.declaredSize}, got ${content.length})`
        );
      }
      return {
        oid: location.oid,
        type: header.packedType,
        content,
      };
    }

    const deltaContent = inflatePackedObject(compressedContent);
    if (deltaContent.length !== header.declaredSize) {
      throw new Error(
        `Packed delta size mismatch: ${location.oid} (expected ${header.declaredSize}, got ${deltaContent.length})`
      );
    }
    const baseObject =
      header.packedType === 'ofs-delta'
        ? await readObject(
            location.packIndex.objectByOffset.get(header.baseOffset!)?.oid ??
              (() => {
                throw new Error(
                  `Missing ofs-delta base object at offset ${header.baseOffset}`
                );
              })()
          )
        : await readObject(
            header.baseOid ??
              (() => {
                throw new Error('Missing ref-delta base object id');
              })()
          );

    const content = applyGitDelta(baseObject.content, deltaContent);

    return {
      oid: location.oid,
      type: baseObject.type,
      content,
    };
  };

  const readObject = async (oid: string): Promise<GitResolvedObject> => {
    const cachedObject = resolvedObjects.get(oid);
    if (cachedObject) {
      return cachedObject;
    }

    const objectPromise = (async (): Promise<GitResolvedObject> => {
      const looseObject = await readLooseObject(actualGitDir, oid);
      if (looseObject) {
        return looseObject;
      }

      const packStore = await getPackStore();
      const location = packStore.objectByOid.get(oid);
      if (!location) {
        throw new Error(`Git object not found: ${oid}`);
      }

      return readPackedObject(location);
    })();

    resolvedObjects.set(oid, objectPromise);
    try {
      return await objectPromise;
    } catch (error) {
      resolvedObjects.delete(oid);
      throw error;
    }
  };

  const resolver: GitObjectResolver = {
    close: async () => {
      if (!packStorePromise) {
        return;
      }

      const packStore = await packStorePromise;
      await Promise.allSettled(
        packStore.packs.map(async (pack) => {
          await pack.fileHandle.close();
        })
      );
    },
    readObject,
    resolveTagOidToCommit: async (tagOid: string): Promise<string> => {
      let currentOid = tagOid;
      const visitedOids = new Set<string>();

      while (true) {
        if (visitedOids.has(currentOid)) {
          throw new Error(`Detected cyclic tag reference: ${currentOid}`);
        }
        visitedOids.add(currentOid);

        const object = await readObject(currentOid);
        if (object.type !== 'tag') {
          return currentOid;
        }

        currentOid = parseTagTargetOid(object.content);
      }
    },
  };

  return resolver;
};

const runWithConcurrency = async <T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> => {
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(values[currentIndex]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      () => runWorker()
    )
  );
};

/**
 * Resolve a tag object OID to the commit OID it ultimately points to.
 * Lightweight tags are returned unchanged.
 * @param repoPath - Repository path
 * @param tagOid - Tag or commit OID
 * @returns Commit hash this tag points to
 */
export const resolveTagOidToCommit = async (
  repoPath: string,
  tagOid: string
): Promise<string> => {
  const resolver = await createGitObjectResolver(repoPath);
  try {
    return await resolver.resolveTagOidToCommit(tagOid);
  } finally {
    await resolver.close();
  }
};

/**
 * Resolve multiple tag object OIDs to their peeled commit OIDs.
 * @param repoPath - Repository path
 * @param tagOids - Tag or commit OIDs
 * @returns Map of tag object OID to peeled commit OID
 */
export const resolveTagOidsToCommits = async (
  repoPath: string,
  tagOids: readonly string[]
): Promise<Map<string, string>> => {
  const resolver = await createGitObjectResolver(repoPath);
  const result = new Map<string, string>();
  const uniqueTagOids = Array.from(new Set(tagOids));

  try {
    await runWithConcurrency(
      uniqueTagOids,
      LOOSE_TAG_RESOLUTION_CONCURRENCY,
      async (tagOid) => {
        result.set(tagOid, await resolver.resolveTagOidToCommit(tagOid));
      }
    );
  } finally {
    await resolver.close();
  }

  return result;
};

const collectTreeFiles = async (
  resolver: GitObjectResolver,
  treeOid: string,
  prefix: string,
  files: Map<string, string>
): Promise<void> => {
  const treeObject = await resolver.readObject(treeOid);
  if (treeObject.type !== 'tree') {
    throw new Error(`Expected tree object: ${treeOid}`);
  }

  for (const entry of parseTreeEntries(treeObject.content)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      await collectTreeFiles(resolver, entry.oid, path, files);
      continue;
    }
    if (entry.mode !== '160000') {
      files.set(path, entry.oid);
    }
  }
};

/**
 * Collect all tracked file blob OIDs under the specified tree.
 * @param repoPath - Repository path
 * @param treeOid - Tree object OID
 * @returns Map of repository-relative file path to blob OID
 */
export const listTreeFiles = async (
  repoPath: string,
  treeOid: string
): Promise<Map<string, string>> => {
  const resolver = await createGitObjectResolver(repoPath);
  const files = new Map<string, string>();

  try {
    await collectTreeFiles(resolver, treeOid, '', files);
  } finally {
    await resolver.close();
  }

  return files;
};
