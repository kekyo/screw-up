// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import fs from 'fs/promises';
import * as git from 'isomorphic-git';
import type { TagInfo, Version } from './analyzer';
import type { Logger } from './internal.js';
import {
  listTagsFast,
  resolveTagsBatch,
  resolveTagsBatchWithCommit,
} from './fast-tags.js';

/**
 * Git operations for tag management
 * Handles all Git interactions
 */

/**
 * Tag with OID information
 */
export interface TagWithOid {
  name: string;
  oid: string; // The OID this tag points to (could be tag object or commit)
  targetCommit?: string; // The commit this tag ultimately points to (resolved from annotated tags)
}

/**
 * Get all tags with their OIDs
 * @param repoPath - Repository path
 * @returns Array of tags with OID information
 */
export const getAllTagsWithOids = async (
  repoPath: string
): Promise<TagWithOid[]> => {
  const tags = await listTagsFast(repoPath);
  const tagHashes = await resolveTagsBatch(repoPath, tags);

  const result: TagWithOid[] = [];
  for (const [tagName, oid] of tagHashes.entries()) {
    result.push({ name: tagName, oid });
  }

  return result;
};

/**
 * Resolve tag OID to commit hash
 * @param repoPath - Repository path
 * @param tagOid - Tag OID
 * @returns Commit hash this tag points to
 */
export const resolveTagToCommit = async (
  repoPath: string,
  tagOid: string
): Promise<string> => {
  try {
    // Try to read as annotated tag
    const tagObject = await git.readTag({
      fs,
      dir: repoPath,
      oid: tagOid,
    });

    if (tagObject?.tag?.object) {
      // Annotated tag - return the commit it points to
      return tagObject.tag.object;
    }
  } catch {
    // Not an annotated tag, must be lightweight
  }

  // Lightweight tag - OID is the commit
  return tagOid;
};

/**
 * Get tag information for specific tags
 * @param repoPath - Repository path
 * @param tagNames - Tag names to get information for
 * @param parseVersion - Function to parse version from tag name
 * @returns Array of TagInfo
 */
export const getTagsInfo = async (
  repoPath: string,
  tagNames: string[],
  parseVersion: (tagName: string) => Version | undefined,
  logger: Logger
): Promise<TagInfo[]> => {
  const startTime = Date.now();
  const result: TagInfo[] = [];

  const tagData = await resolveTagsBatchWithCommit(repoPath, tagNames, logger);

  for (const tagName of tagNames) {
    const data = tagData.get(tagName);
    if (!data) {
      logger.warn(`[git-ops] Tag ${tagName} not found`);
      continue;
    }

    const { commitOid } = data;
    const version = parseVersion(tagName);

    result.push({
      name: tagName,
      hash: commitOid,
      version,
    });
  }

  logger.debug(`[git-ops] getTagsInfo: ${Date.now() - startTime}ms`);
  logger.debug(
    `[git-ops] Got info for ${result.length}/${tagNames.length} tags`
  );

  return result;
};

/**
 * Build complete tag cache from repository
 * @param repoPath - Repository path
 * @param parseVersion - Function to parse version from tag name
 * @returns Map of commit hash to TagInfo array
 */
export const buildCompleteTagCache = async (
  repoPath: string,
  parseVersion: (tagName: string) => Version | undefined,
  logger: Logger
): Promise<Map<string, TagInfo[]>> => {
  const totalStart = Date.now();
  const cache = new Map<string, TagInfo[]>();

  const listStart = Date.now();
  const tags = await listTagsFast(repoPath);
  logger.debug(`[git-ops] listTagsFast: ${Date.now() - listStart}ms`);
  logger.debug(`[git-ops] Found ${tags.length} tags`);

  const resolveStart = Date.now();
  const tagData = await resolveTagsBatchWithCommit(repoPath, tags, logger);
  logger.debug(
    `[git-ops] resolveTagsBatchWithCommit: ${Date.now() - resolveStart}ms`
  );

  const buildStart = Date.now();
  for (const tagName of tags) {
    const data = tagData.get(tagName);
    if (!data) continue;

    const { commitOid } = data;
    const version = parseVersion(tagName);

    const tagInfo: TagInfo = {
      name: tagName,
      hash: commitOid,
      version,
    };

    if (!cache.has(commitOid)) {
      cache.set(commitOid, []);
    }
    cache.get(commitOid)!.push(tagInfo);
  }
  logger.debug(`[git-ops] build cache map: ${Date.now() - buildStart}ms`);

  // Sort tags by name for each commit to ensure consistent ordering
  const sortStart = Date.now();
  for (const tags of cache.values()) {
    tags.sort((a, b) => a.name.localeCompare(b.name));
  }
  logger.debug(`[git-ops] sort tags: ${Date.now() - sortStart}ms`);

  logger.debug(
    `[git-ops] buildCompleteTagCache total: ${Date.now() - totalStart}ms`
  );
  logger.debug(`[git-ops] Built cache with ${cache.size} unique commits`);

  return cache;
};

/**
 * Check if a tag has moved to a different commit
 * @param repoPath - Repository path
 * @param tagName - Tag name
 * @param cachedCommit - Commit hash from cache
 * @returns True if tag has moved
 */
export const hasTagMoved = async (
  repoPath: string,
  tagName: string,
  cachedCommit: string
): Promise<boolean> => {
  try {
    const oid = await git.resolveRef({
      fs,
      dir: repoPath,
      ref: `refs/tags/${tagName}`,
    });

    const currentCommit = await resolveTagToCommit(repoPath, oid);
    return currentCommit !== cachedCommit;
  } catch {
    // Tag doesn't exist anymore
    return true;
  }
};

/**
 * Find modified tags (tags that point to different commits)
 * @param repoPath - Repository path
 * @param tagNames - Tag names to check
 * @param cache - Current cache
 * @returns Array of modified tag names
 */
export const findModifiedTags = async (
  repoPath: string,
  tagNames: string[],
  cache: Map<string, TagInfo[]>,
  logger: Logger
): Promise<string[]> => {
  const totalStart = Date.now();
  const modified: string[] = [];

  // Batch resolve all tags at once with commit hashes
  const resolveStart = Date.now();
  const tagData = await resolveTagsBatchWithCommit(repoPath, tagNames, logger);
  logger.debug(
    `[git-ops] resolveTagsBatchWithCommit in findModified: ${Date.now() - resolveStart}ms`
  );

  const checkStart = Date.now();
  // Process each tag
  for (const tagName of tagNames) {
    // Find tag in cache
    let cachedCommit: string | undefined;
    for (const [commit, tags] of cache.entries()) {
      const tag = tags.find((t) => t.name === tagName);
      if (tag) {
        cachedCommit = commit;
        break;
      }
    }

    if (cachedCommit) {
      const data = tagData.get(tagName);
      if (!data) {
        // Tag doesn't exist anymore
        modified.push(tagName);
      } else {
        const { commitOid } = data;
        if (commitOid !== cachedCommit) {
          modified.push(tagName);
        }
      }
    }
  }
  logger.debug(`[git-ops] check modified tags: ${Date.now() - checkStart}ms`);

  logger.debug(
    `[git-ops] findModifiedTags total: ${Date.now() - totalStart}ms`
  );
  logger.debug(
    `[git-ops] Found ${modified.length} modified tags out of ${tagNames.length}`
  );

  return modified;
};
