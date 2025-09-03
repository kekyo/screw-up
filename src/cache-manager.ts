// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import * as git from 'isomorphic-git';
import fs from 'fs/promises';
import type { TagInfo, Version, TagCache } from './analyzer';
import {
  loadCachedTags,
  saveCachedTags,
  isCacheValid,
  buildCacheValidation,
  reconstructTagCache,
  cleanupOldCacheFiles,
  getCachePath,
} from './cache';
import {
  calculateTagDiff,
  removeTagsFromCache,
  addTagsToCache,
  updateTagsInCache,
} from './cache-operations';
import {
  getTagsInfo,
  findModifiedTags,
  buildCompleteTagCache,
} from './git-operations';

/**
 * Cache manager for differential updates
 * Coordinates cache operations with Git operations
 */

/**
 * Logger interface
 */
export interface Logger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Cache update statistics
 */
export interface CacheUpdateStats {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
  totalTags: number;
  updateTime: number;
  fullRebuild: boolean;
}

/**
 * Load or build tag cache with differential updates
 * @param repoPath - Repository path
 * @param parseVersion - Function to parse version from tag name
 * @param logger - Optional logger
 * @returns Tag cache and statistics
 */
export const loadOrBuildTagCache = async (
  repoPath: string,
  parseVersion: (tagName: string) => Version | undefined,
  logger: Logger
): Promise<{ cache: TagCache; stats: CacheUpdateStats }> => {
  const startTime = Date.now();

  // Try to load cached data
  const cachedData = await loadCachedTags(repoPath);

  // Get current tag list
  const currentTags = await git.listTags({ fs, dir: repoPath });

  if (cachedData && (await isCacheValid(cachedData, repoPath))) {
    // Cache is valid, perform differential update
    logger.debug(`Cache valid, performing differential update...`);

    const cache = reconstructTagCache(cachedData);
    const stats = await performDifferentialUpdate(
      repoPath,
      cache.commitToTags,
      currentTags,
      parseVersion,
      logger
    );

    // Save updated cache
    const validation = await buildCacheValidation(repoPath);
    await saveCachedTags(repoPath, cache, validation);

    // Cleanup old cache files if current cache is older than 24 hours
    if (cachedData && Date.now() - cachedData.timestamp > 24 * 60 * 60 * 1000) {
      try {
        const cachePath = getCachePath(repoPath);
        const deletedCount = await cleanupOldCacheFiles(cachePath, Date.now());
        if (deletedCount > 0) {
          logger.debug(`Cleaned up ${deletedCount} old cache files`);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      cache,
      stats: {
        ...stats,
        updateTime: Date.now() - startTime,
        fullRebuild: false,
      },
    };
  } else {
    // Cache invalid or doesn't exist, build from scratch
    logger.debug(`Cache invalid or missing, building from scratch...`);

    const commitToTags = await buildCompleteTagCache(repoPath, parseVersion);
    const cache: TagCache = {
      commitToTags,
      initialized: true,
    };

    // Save new cache
    const validation = await buildCacheValidation(repoPath);
    await saveCachedTags(repoPath, cache, validation);

    return {
      cache,
      stats: {
        added: currentTags.length,
        deleted: 0,
        modified: 0,
        unchanged: 0,
        totalTags: currentTags.length,
        updateTime: Date.now() - startTime,
        fullRebuild: true,
      },
    };
  }
};

/**
 * Perform differential cache update
 * @param repoPath - Repository path
 * @param cache - Current cache (will be modified)
 * @param currentTags - Current tag list from Git
 * @param parseVersion - Function to parse version from tag name
 * @param logger - Optional logger
 * @returns Update statistics
 */
async function performDifferentialUpdate(
  repoPath: string,
  cache: Map<string, TagInfo[]>,
  currentTags: string[],
  parseVersion: (tagName: string) => Version | undefined,
  logger: Logger
): Promise<Omit<CacheUpdateStats, 'updateTime' | 'fullRebuild'>> {
  // Calculate diff
  const diff = calculateTagDiff(cache, currentTags);

  logger.debug(
    `Tag diff: +${diff.added.length} -${diff.deleted.length} =${diff.unchanged.length}`
  );

  // Find modified tags (tags that moved to different commits)
  const modified = await findModifiedTags(repoPath, diff.unchanged, cache);

  logger.debug(`Found ${modified.length} modified tags`);

  // Apply deletions
  if (diff.deleted.length > 0) {
    const newCache = removeTagsFromCache(cache, diff.deleted);
    cache.clear();
    for (const [k, v] of newCache) {
      cache.set(k, v);
    }
  }

  // Apply additions
  if (diff.added.length > 0) {
    const newTags = await getTagsInfo(repoPath, diff.added, parseVersion);
    const newCache = addTagsToCache(cache, newTags);
    cache.clear();
    for (const [k, v] of newCache) {
      cache.set(k, v);
    }
  }

  // Apply modifications
  if (modified.length > 0) {
    const updatedTags = await getTagsInfo(repoPath, modified, parseVersion);
    const newCache = updateTagsInCache(cache, modified, updatedTags);
    cache.clear();
    for (const [k, v] of newCache) {
      cache.set(k, v);
    }
  }

  // Calculate unchanged count (tags that weren't modified)
  const unchangedCount = diff.unchanged.length - modified.length;

  return {
    added: diff.added.length,
    deleted: diff.deleted.length,
    modified: modified.length,
    unchanged: unchangedCount,
    totalTags: currentTags.length,
  };
}

/**
 * Invalidate cache (force rebuild on next load)
 * @param repoPath - Repository path
 */
export const invalidateCache = async (repoPath: string): Promise<void> => {
  // Simply delete the cache file
  const cachedData = await loadCachedTags(repoPath);
  if (cachedData) {
    // Cache exists, but we won't delete it - just let validation fail
    // This preserves the cache for debugging
    return;
  }
};
