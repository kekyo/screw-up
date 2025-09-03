// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import fs from 'fs/promises';
import * as git from 'isomorphic-git';
import type { TagInfo, Version } from './analyzer';

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
  const tags = await git.listTags({ fs, dir: repoPath });
  const result: TagWithOid[] = [];

  await Promise.all(
    tags.map(async (tagName) => {
      const oid = await git.resolveRef({
        fs,
        dir: repoPath,
        ref: `refs/tags/${tagName}`,
      });
      result.push({ name: tagName, oid });
    })
  );

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
  parseVersion: (tagName: string) => Version | undefined
): Promise<TagInfo[]> => {
  const result: TagInfo[] = [];

  await Promise.all(
    tagNames.map(async (tagName) => {
      try {
        const oid = await git.resolveRef({
          fs,
          dir: repoPath,
          ref: `refs/tags/${tagName}`,
        });

        const commitHash = await resolveTagToCommit(repoPath, oid);
        const version = parseVersion(tagName);

        result.push({
          name: tagName,
          hash: commitHash,
          version,
        });
      } catch (error) {
        // Tag might have been deleted between operations
        console.warn(`Failed to get info for tag ${tagName}:`, error);
      }
    })
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
  parseVersion: (tagName: string) => Version | undefined
): Promise<Map<string, TagInfo[]>> => {
  const cache = new Map<string, TagInfo[]>();
  const tags = await git.listTags({ fs, dir: repoPath });

  await Promise.all(
    tags.map(async (tagName) => {
      const oid = await git.resolveRef({
        fs,
        dir: repoPath,
        ref: `refs/tags/${tagName}`,
      });

      const commitHash = await resolveTagToCommit(repoPath, oid);
      const version = parseVersion(tagName);

      const tagInfo: TagInfo = {
        name: tagName,
        hash: commitHash,
        version,
      };

      if (!cache.has(commitHash)) {
        cache.set(commitHash, []);
      }
      cache.get(commitHash)!.push(tagInfo);
    })
  );

  // Sort tags by name for each commit to ensure consistent ordering
  for (const tags of cache.values()) {
    tags.sort((a, b) => a.name.localeCompare(b.name));
  }

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
  cache: Map<string, TagInfo[]>
): Promise<string[]> => {
  const modified: string[] = [];

  await Promise.all(
    tagNames.map(async (tagName) => {
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
        const moved = await hasTagMoved(repoPath, tagName, cachedCommit);
        if (moved) {
          modified.push(tagName);
        }
      }
    })
  );

  return modified;
};
