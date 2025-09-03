// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import type { TagInfo } from './analyzer';

/**
 * Pure functions for cache operations
 * No side effects, fully testable
 */

/**
 * Tag difference result
 */
export interface TagDiff {
  added: string[]; // Newly added tag names
  deleted: string[]; // Deleted tag names
  unchanged: string[]; // Unchanged tag names
  // Note: modified tags are detected later by checking OIDs
}

/**
 * Calculate differences between cached tags and current tag list
 * @param cachedTags - Map of commit hash to tag info array
 * @param currentTagList - Current list of tag names from git
 * @returns Tag difference information
 */
export const calculateTagDiff = (
  cachedTags: Map<string, TagInfo[]>,
  currentTagList: string[]
): TagDiff => {
  // Extract all tag names from cache
  const cachedTagNames = new Set<string>();
  for (const tags of cachedTags.values()) {
    for (const tag of tags) {
      cachedTagNames.add(tag.name);
    }
  }

  const currentSet = new Set(currentTagList);

  // Calculate differences
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const tagName of currentTagList) {
    if (cachedTagNames.has(tagName)) {
      unchanged.push(tagName);
    } else {
      added.push(tagName);
    }
  }

  const deleted: string[] = [];
  for (const tagName of cachedTagNames) {
    if (!currentSet.has(tagName)) {
      deleted.push(tagName);
    }
  }

  return { added, deleted, unchanged };
};

/**
 * Remove tags from cache
 * @param cache - Original cache (not modified)
 * @param tagNames - Tag names to remove
 * @returns New cache without specified tags
 */
export const removeTagsFromCache = (
  cache: Map<string, TagInfo[]>,
  tagNames: string[]
): Map<string, TagInfo[]> => {
  const tagNamesToRemove = new Set(tagNames);
  const newCache = new Map<string, TagInfo[]>();

  for (const [commitHash, tags] of cache.entries()) {
    const filteredTags = tags.filter((tag) => !tagNamesToRemove.has(tag.name));
    if (filteredTags.length > 0) {
      newCache.set(commitHash, filteredTags);
    }
  }

  return newCache;
};

/**
 * Add tags to cache
 * @param cache - Original cache (not modified)
 * @param newTags - Tags to add
 * @returns New cache with added tags
 */
export const addTagsToCache = (
  cache: Map<string, TagInfo[]>,
  newTags: TagInfo[]
): Map<string, TagInfo[]> => {
  const newCache = new Map<string, TagInfo[]>(cache);

  for (const tag of newTags) {
    const existing = newCache.get(tag.hash) || [];
    const updated = [...existing, tag];
    // Sort tags by name to ensure consistent ordering
    updated.sort((a, b) => a.name.localeCompare(b.name));
    newCache.set(tag.hash, updated);
  }

  return newCache;
};

/**
 * Update tags in cache (remove old versions, add new ones)
 * @param cache - Original cache (not modified)
 * @param tagNames - Tag names to update
 * @param updatedTags - New tag information
 * @returns New cache with updated tags
 */
export const updateTagsInCache = (
  cache: Map<string, TagInfo[]>,
  tagNames: string[],
  updatedTags: TagInfo[]
): Map<string, TagInfo[]> => {
  // First remove old versions
  let newCache = removeTagsFromCache(cache, tagNames);

  // Then add new versions
  newCache = addTagsToCache(newCache, updatedTags);

  return newCache;
};

/**
 * Find a tag by name in the cache
 * @param cache - Cache to search
 * @param tagName - Tag name to find
 * @returns Tag info if found, undefined otherwise
 */
export const findTagInCache = (
  cache: Map<string, TagInfo[]>,
  tagName: string
): TagInfo | undefined => {
  for (const tags of cache.values()) {
    const found = tags.find((tag) => tag.name === tagName);
    if (found) {
      return found;
    }
  }
  return undefined;
};

/**
 * Get all tag names from cache
 * @param cache - Cache to extract from
 * @returns Array of all tag names
 */
export const getAllTagNames = (cache: Map<string, TagInfo[]>): string[] => {
  const names: string[] = [];
  for (const tags of cache.values()) {
    for (const tag of tags) {
      names.push(tag.name);
    }
  }
  return names;
};

/**
 * Count total tags in cache
 * @param cache - Cache to count
 * @returns Total number of tags
 */
export const countTags = (cache: Map<string, TagInfo[]>): number => {
  let count = 0;
  for (const tags of cache.values()) {
    count += tags.length;
  }
  return count;
};

/**
 * Merge two caches
 * @param cache1 - First cache
 * @param cache2 - Second cache (takes precedence for conflicts)
 * @returns Merged cache
 */
export const mergeCaches = (
  cache1: Map<string, TagInfo[]>,
  cache2: Map<string, TagInfo[]>
): Map<string, TagInfo[]> => {
  const merged = new Map<string, TagInfo[]>();

  // Add all from cache1
  for (const [hash, tags] of cache1.entries()) {
    merged.set(hash, [...tags]);
  }

  // Merge in cache2 (overwrites duplicates by tag name)
  for (const [hash, tags] of cache2.entries()) {
    const existing = merged.get(hash) || [];
    const existingNames = new Set(existing.map((t) => t.name));

    // Add only non-duplicate tags
    const newTags = tags.filter((tag) => !existingNames.has(tag.name));
    if (existing.length > 0 || newTags.length > 0) {
      const mergedTags = [...existing, ...newTags];
      // Sort tags by name to ensure consistent ordering
      mergedTags.sort((a, b) => a.name.localeCompare(b.name));
      merged.set(hash, mergedTags);
    }
  }

  return merged;
};
