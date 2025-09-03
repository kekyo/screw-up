// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import * as git from 'isomorphic-git';
import type { TagCache, TagInfo } from './analyzer';

/**
 * Cache management for tag information
 */

/**
 * Cache validation information
 */
interface CacheValidation {
  tagListHash: string; // SHA256 hash of all tag names
  tagCount: number; // Total number of tags
  packedRefsMtime?: number; // .git/packed-refs modification time
  refsTagsMtime?: number; // .git/refs/tags/ modification time
}

/**
 * Cached data structure
 */
interface CachedData {
  version: '1.0.0'; // Cache format version
  timestamp: number; // Cache creation timestamp (ms)
  repository: {
    path: string; // Original repository path (for debugging)
  };
  validation: CacheValidation;
  tagCache: {
    commitToTags: Record<string, TagInfo[]>;
  };
}

/**
 * Get cache file path for a repository
 */
const getCachePath = (repoPath: string): string => {
  const absoluteRepoPath = path.resolve(repoPath);

  // Hash repository path with SHA1
  const pathHash = crypto
    .createHash('sha1')
    .update(absoluteRepoPath)
    .digest('hex');

  return path.join(
    os.homedir(),
    '.cache',
    'screw-up',
    'tag-cache',
    `${pathHash}.json`
  );
};

/**
 * Build cache validation information
 */
export const buildCacheValidation = async (
  repoPath: string
): Promise<CacheValidation> => {
  // Get all tags
  const tags = await git.listTags({ fs, dir: repoPath });

  // Create hash of tag list
  const tagListHash = crypto
    .createHash('sha256')
    .update(tags.sort().join('\n'))
    .digest('hex');

  const validation: CacheValidation = {
    tagListHash,
    tagCount: tags.length,
  };

  // Get file modification times
  try {
    const packedRefsPath = path.join(repoPath, '.git', 'packed-refs');
    const stats = await fs.stat(packedRefsPath);
    validation.packedRefsMtime = stats.mtimeMs;
  } catch {
    // packed-refs might not exist
  }

  try {
    const refsTagsPath = path.join(repoPath, '.git', 'refs', 'tags');
    const stats = await fs.stat(refsTagsPath);
    validation.refsTagsMtime = stats.mtimeMs;
  } catch {
    // refs/tags might not exist
  }

  return validation;
};

/**
 * Check if cached data is still valid
 */
export const isCacheValid = async (
  cachedData: CachedData,
  repoPath: string
): Promise<boolean> => {
  try {
    // Quick check: tag count
    const currentTags = await git.listTags({ fs, dir: repoPath });
    if (currentTags.length !== cachedData.validation.tagCount) {
      return false;
    }

    // Definitive check: tag list hash
    const tagListHash = crypto
      .createHash('sha256')
      .update(currentTags.sort().join('\n'))
      .digest('hex');

    if (cachedData.validation.tagListHash !== tagListHash) {
      return false;
    }

    // Additional filesystem checks
    if (cachedData.validation.packedRefsMtime !== undefined) {
      try {
        const packedRefsPath = path.join(repoPath, '.git', 'packed-refs');
        const stats = await fs.stat(packedRefsPath);
        if (stats.mtimeMs > cachedData.timestamp) {
          return false;
        }
      } catch {
        // File might have been deleted
      }
    }

    if (cachedData.validation.refsTagsMtime !== undefined) {
      try {
        const refsTagsPath = path.join(repoPath, '.git', 'refs', 'tags');
        const stats = await fs.stat(refsTagsPath);
        if (stats.mtimeMs > cachedData.timestamp) {
          return false;
        }
      } catch {
        // Directory might have been deleted
      }
    }

    return true;
  } catch {
    return false;
  }
};

/**
 * Load cached tags from disk
 */
export const loadCachedTags = async (
  repoPath: string
): Promise<CachedData | null> => {
  try {
    const cachePath = getCachePath(repoPath);
    const data = await fs.readFile(cachePath, 'utf-8');
    const cachedData = JSON.parse(data) as CachedData;

    // Check version compatibility
    if (cachedData.version !== '1.0.0') {
      return null;
    }

    return cachedData;
  } catch {
    // Cache doesn't exist or is corrupted
    return null;
  }
};

/**
 * Save tag cache to disk atomically
 */
export const saveCachedTags = async (
  repoPath: string,
  tagCache: TagCache,
  validation: CacheValidation
): Promise<void> => {
  const cachePath = getCachePath(repoPath);
  const cacheDir = path.dirname(cachePath);

  // Ensure cache directory exists
  await fs.mkdir(cacheDir, { recursive: true });

  // Generate random suffix for temp file
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempPath = cachePath.replace('.json', `_${randomSuffix}.json`);

  // Prepare data
  const data: CachedData = {
    version: '1.0.0',
    timestamp: Date.now(),
    repository: {
      path: repoPath,
    },
    validation,
    tagCache: {
      commitToTags: Object.fromEntries(tagCache.commitToTags),
    },
  };

  try {
    // Write to temp file
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');

    // Atomically rename to final path
    await fs.rename(tempPath, cachePath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
};

/**
 * Convert cached data back to Map structure
 */
export const reconstructTagCache = (cachedData: CachedData): TagCache => {
  return {
    commitToTags: new Map(Object.entries(cachedData.tagCache.commitToTags)),
    initialized: true,
  };
};
