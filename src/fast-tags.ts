// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { readdir, readFile, stat } from 'fs/promises';
import { isAbsolute, join } from 'path';
import type { Logger } from './internal.js';

/**
 * Fast tag listing implementation that reads tags directly from filesystem
 * instead of using isomorphic-git's `listTags`
 */

/**
 * Parse packed-refs file to extract tags
 * @param packedRefsPath - Path to packed-refs file
 * @returns Array of tag names
 */
const parsePackedRefs = async (packedRefsPath: string): Promise<string[]> => {
  try {
    const content = await readFile(packedRefsPath, 'utf-8');
    const lines = content.split('\n');
    const tags: string[] = [];

    for (const line of lines) {
      // Skip comments and empty lines
      if (line.startsWith('#') || !line.trim()) continue;

      // Format: <hash> refs/tags/<tagname>
      const match = line.match(/^[0-9a-f]{40}\s+refs\/tags\/(.+)$/);
      if (match) {
        // Handle peeled tags (annotated tags) marked with ^{}
        const tagName = match[1];
        if (!tagName.endsWith('^{}')) {
          tags.push(tagName);
        }
      }
    }

    return tags;
  } catch (error) {
    // packed-refs might not exist, which is fine
    if ((error as any).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/**
 * Read loose tag refs from refs/tags directory
 * @param refsTagsPath - Path to refs/tags directory
 * @returns Array of tag names
 */
const readLooseTags = async (refsTagsPath: string): Promise<string[]> => {
  try {
    const entries = await readdir(refsTagsPath, { withFileTypes: true });
    const tags: string[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        tags.push(entry.name);
      }
    }

    return tags;
  } catch (error) {
    // refs/tags might not exist, which is fine
    if ((error as any).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/**
 * Fast implementation of listTags that reads directly from filesystem
 * @param repoPath - Repository path
 * @returns Array of all tag names
 */
export const listTagsFast = async (repoPath: string): Promise<string[]> => {
  const gitDir = join(repoPath, '.git');

  // Check if .git is a file (submodule or worktree)
  const gitStat = await stat(gitDir).catch(() => null);
  let actualGitDir = gitDir;

  if (gitStat?.isFile()) {
    // Read the actual git dir location from .git file
    const content = await readFile(gitDir, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      actualGitDir = isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
    }
  }

  // Read tags from both packed-refs and loose refs
  const [packedTags, looseTags] = await Promise.all([
    parsePackedRefs(join(actualGitDir, 'packed-refs')),
    readLooseTags(join(actualGitDir, 'refs', 'tags')),
  ]);

  // Combine and deduplicate tags
  const allTags = new Set<string>([...packedTags, ...looseTags]);

  // Sort tags for consistent output (matching git.listTags behavior)
  return Array.from(allTags).sort();
};

/**
 * Get hash for a specific tag by reading refs directly
 * @param repoPath - Repository path
 * @param tagName - Name of the tag
 * @returns The SHA-1 hash the tag points to, or null if not found
 */
export const resolveTagFast = async (
  repoPath: string,
  tagName: string
): Promise<string | null> => {
  const gitDir = join(repoPath, '.git');

  // Check if .git is a file (submodule or worktree)
  const gitStat = await stat(gitDir).catch(() => null);
  let actualGitDir = gitDir;

  if (gitStat?.isFile()) {
    const content = await readFile(gitDir, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      actualGitDir = isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
    }
  }

  // First try loose ref
  const looseRefPath = join(actualGitDir, 'refs', 'tags', tagName);
  try {
    const hash = await readFile(looseRefPath, 'utf-8');
    return hash.trim();
  } catch (error) {
    if ((error as any).code !== 'ENOENT') {
      throw error;
    }
  }

  // Then try packed-refs
  const packedRefsPath = join(actualGitDir, 'packed-refs');
  try {
    const content = await readFile(packedRefsPath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comments and empty lines
      if (line.startsWith('#') || !line.trim()) continue;

      // Check if this line is for our tag
      const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+)$/);
      if (match && match[2] === tagName) {
        // Check if next line is a peeled ref (^{})
        if (i + 1 < lines.length && lines[i + 1].startsWith('^')) {
          // Return the peeled ref (points directly to commit)
          return lines[i + 1].substring(1, 41);
        }
        // Return the tag object hash
        return match[1];
      }
    }
  } catch (error) {
    if ((error as any).code !== 'ENOENT') {
      throw error;
    }
  }

  return null;
};

/**
 * Batch resolve multiple tags for better performance
 * @param repoPath - Repository path
 * @param tagNames - Array of tag names to resolve
 * @returns Map of tag name to hash
 */
export const resolveTagsBatch = async (
  repoPath: string,
  tagNames: string[]
): Promise<Map<string, string>> => {
  const gitDir = join(repoPath, '.git');
  const result = new Map<string, string>();

  // Check if .git is a file (submodule or worktree)
  const gitStat = await stat(gitDir).catch(() => null);
  let actualGitDir = gitDir;

  if (gitStat?.isFile()) {
    const content = await readFile(gitDir, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      actualGitDir = isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
    }
  }

  // Create a set for faster lookup
  const tagSet = new Set(tagNames);

  // First, read all packed refs in one go
  try {
    const content = await readFile(join(actualGitDir, 'packed-refs'), 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#') || !line.trim()) continue;

      const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+)$/);
      if (match && tagSet.has(match[2])) {
        // Check for peeled ref
        if (i + 1 < lines.length && lines[i + 1].startsWith('^')) {
          result.set(match[2], lines[i + 1].substring(1, 41));
        } else {
          result.set(match[2], match[1]);
        }
      }
    }
  } catch (error) {
    // packed-refs might not exist
    if ((error as any).code !== 'ENOENT') {
      throw error;
    }
  }

  // Then check loose refs for tags not found in packed-refs
  const remainingTags = tagNames.filter((tag) => !result.has(tag));

  await Promise.all(
    remainingTags.map(async (tagName) => {
      const looseRefPath = join(actualGitDir, 'refs', 'tags', tagName);
      try {
        const hash = await readFile(looseRefPath, 'utf-8');
        result.set(tagName, hash.trim());
      } catch (error) {
        // Tag doesn't exist as loose ref either
        if ((error as any).code !== 'ENOENT') {
          throw error;
        }
      }
    })
  );

  return result;
};

/**
 * Batch resolve multiple tags with their commit hashes for better performance
 * @param repoPath - Repository path
 * @param tagNames - Array of tag names to resolve
 * @returns Map of tag name to {oid, commitOid}
 */
export const resolveTagsBatchWithCommit = async (
  repoPath: string,
  tagNames: string[],
  logger: Logger
): Promise<Map<string, { oid: string; commitOid: string }>> => {
  const startTime = Date.now();

  const gitDir = join(repoPath, '.git');
  const result = new Map<string, { oid: string; commitOid: string }>();

  // Check if .git is a file (submodule or worktree)
  const gitStat = await stat(gitDir).catch(() => null);
  let actualGitDir = gitDir;

  if (gitStat?.isFile()) {
    const content = await readFile(gitDir, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      actualGitDir = isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
    }
  }

  // Create a set for faster lookup
  const tagSet = new Set(tagNames);

  // First, read all packed refs in one go
  const packedRefsStart = Date.now();
  try {
    const content = await readFile(join(actualGitDir, 'packed-refs'), 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#') || !line.trim()) continue;

      const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+)$/);
      if (match && tagSet.has(match[2])) {
        const tagName = match[2];
        const oid = match[1];

        // Check for peeled ref on next line
        let commitOid = oid; // Default: assume lightweight tag
        if (i + 1 < lines.length && lines[i + 1].startsWith('^')) {
          // This is an annotated tag, next line has the commit
          commitOid = lines[i + 1].substring(1, 41);
        }

        result.set(tagName, { oid, commitOid });
      }
    }
  } catch (error) {
    // packed-refs might not exist
    if ((error as any).code !== 'ENOENT') {
      throw error;
    }
  }
  logger.debug(
    `[fast-tags] read packed-refs: ${Date.now() - packedRefsStart}ms`
  );

  // Then check loose refs for tags not found in packed-refs
  const remainingTags = tagNames.filter((tag) => !result.has(tag));

  if (remainingTags.length > 0) {
    const looseRefsStart = Date.now();
    await Promise.all(
      remainingTags.map(async (tagName) => {
        const looseRefPath = join(actualGitDir, 'refs', 'tags', tagName);
        try {
          const hash = await readFile(looseRefPath, 'utf-8');
          const oid = hash.trim();

          // Check if this is an annotated tag by reading the object type
          let commitOid = oid;
          try {
            // Use git cat-file to check object type
            const { execSync } = require('child_process');
            const objectType = execSync(
              `git -C "${repoPath}" cat-file -t ${oid}`,
              { encoding: 'utf-8' }
            ).trim();

            if (objectType === 'tag') {
              // It's an annotated tag, extract the commit it points to
              const tagContent = execSync(
                `git -C "${repoPath}" cat-file -p ${oid}`,
                { encoding: 'utf-8' }
              );
              const objectMatch = tagContent.match(/^object ([0-9a-f]{40})$/m);
              if (objectMatch) {
                commitOid = objectMatch[1];
              }
            }
          } catch (error) {
            // If git cat-file fails, assume it's a lightweight tag
            logger.debug(
              `[fast-tags] Could not determine object type for ${tagName}: ${error}`
            );
          }

          result.set(tagName, { oid, commitOid });
        } catch (error) {
          // Tag doesn't exist as loose ref either
          if ((error as any).code !== 'ENOENT') {
            throw error;
          }
        }
      })
    );
    logger.debug(
      `[fast-tags] read loose refs: ${Date.now() - looseRefsStart}ms`
    );
  }

  const totalTime = Date.now() - startTime;
  logger.debug(`[fast-tags] resolveTagsBatchWithCommit total: ${totalTime}ms`);
  logger.debug(`[fast-tags] Resolved ${result.size}/${tagNames.length} tags`);

  return result;
};
