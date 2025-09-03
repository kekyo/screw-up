/**
 * Tests for cache-operations.ts pure functions
 */

import { describe, it, expect } from 'vitest';
import {
  calculateTagDiff,
  removeTagsFromCache,
  addTagsToCache,
  updateTagsInCache,
  findTagInCache,
  getAllTagNames,
  countTags,
  mergeCaches,
} from '../src/cache-operations';
import type { TagInfo } from '../src/analyzer';

describe('calculateTagDiff', () => {
  it('detects added tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const current = ['v1.0.0', 'v1.1.0'];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual(['v1.1.0']);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual(['v1.0.0']);
  });

  it('detects deleted tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);
    const current = ['v1.0.0'];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual(['v1.1.0']);
    expect(diff.unchanged).toEqual(['v1.0.0']);
  });

  it('detects unchanged tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);
    const current = ['v1.0.0', 'v1.1.0'];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual(['v1.0.0', 'v1.1.0']);
  });

  it('handles empty cache', () => {
    const cache = new Map<string, TagInfo[]>();
    const current = ['v1.0.0', 'v1.1.0'];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual(['v1.0.0', 'v1.1.0']);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles empty current list', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const current: string[] = [];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual(['v1.0.0']);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles multiple tags on same commit', () => {
    const cache = new Map<string, TagInfo[]>([
      [
        'commit1',
        [
          { name: 'v1.0.0', hash: 'commit1', version: undefined },
          { name: 'release-1.0', hash: 'commit1', version: undefined },
        ],
      ],
    ]);
    const current = ['v1.0.0', 'release-1.0', 'v2.0.0'];

    const diff = calculateTagDiff(cache, current);

    expect(diff.added).toEqual(['v2.0.0']);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toContain('v1.0.0');
    expect(diff.unchanged).toContain('release-1.0');
  });
});

describe('removeTagsFromCache', () => {
  it('removes single tag', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const newCache = removeTagsFromCache(cache, ['v1.0.0']);

    expect(newCache.has('commit1')).toBe(false);
    expect(newCache.get('commit2')).toEqual([
      { name: 'v1.1.0', hash: 'commit2', version: undefined },
    ]);
  });

  it('removes multiple tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const newCache = removeTagsFromCache(cache, ['v1.0.0', 'v1.1.0']);

    expect(newCache.size).toBe(0);
  });

  it('removes only specified tags from commit with multiple tags', () => {
    const cache = new Map<string, TagInfo[]>([
      [
        'commit1',
        [
          { name: 'v1.0.0', hash: 'commit1', version: undefined },
          { name: 'release-1.0', hash: 'commit1', version: undefined },
        ],
      ],
    ]);

    const newCache = removeTagsFromCache(cache, ['v1.0.0']);

    expect(newCache.get('commit1')).toEqual([
      { name: 'release-1.0', hash: 'commit1', version: undefined },
    ]);
  });

  it('does not modify original cache', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const originalSize = cache.size;

    removeTagsFromCache(cache, ['v1.0.0']);

    expect(cache.size).toBe(originalSize);
    expect(cache.has('commit1')).toBe(true);
  });

  it('handles non-existent tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);

    const newCache = removeTagsFromCache(cache, ['v2.0.0']);

    expect(newCache.get('commit1')).toEqual([
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
    ]);
  });
});

describe('addTagsToCache', () => {
  it('adds single tag to empty cache', () => {
    const cache = new Map<string, TagInfo[]>();
    const newTags: TagInfo[] = [
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
    ];

    const newCache = addTagsToCache(cache, newTags);

    expect(newCache.get('commit1')).toEqual([
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
    ]);
  });

  it('adds tag to existing commit', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const newTags: TagInfo[] = [
      { name: 'v1.0.1', hash: 'commit1', version: undefined },
    ];

    const newCache = addTagsToCache(cache, newTags);

    expect(newCache.get('commit1')).toHaveLength(2);
    expect(newCache.get('commit1')).toContainEqual({
      name: 'v1.0.0',
      hash: 'commit1',
      version: undefined,
    });
    expect(newCache.get('commit1')).toContainEqual({
      name: 'v1.0.1',
      hash: 'commit1',
      version: undefined,
    });
  });

  it('adds multiple tags to different commits', () => {
    const cache = new Map<string, TagInfo[]>();
    const newTags: TagInfo[] = [
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
      { name: 'v1.1.0', hash: 'commit2', version: undefined },
      { name: 'v1.2.0', hash: 'commit1', version: undefined },
    ];

    const newCache = addTagsToCache(cache, newTags);

    expect(newCache.get('commit1')).toHaveLength(2);
    expect(newCache.get('commit2')).toHaveLength(1);
  });

  it('does not modify original cache', () => {
    const cache = new Map<string, TagInfo[]>();
    const originalSize = cache.size;

    addTagsToCache(cache, [
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
    ]);

    expect(cache.size).toBe(originalSize);
  });
});

describe('updateTagsInCache', () => {
  it('updates tag that moved to different commit', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const updatedTags: TagInfo[] = [
      { name: 'v1.0.0', hash: 'commit2', version: undefined },
    ];

    const newCache = updateTagsInCache(cache, ['v1.0.0'], updatedTags);

    expect(newCache.has('commit1')).toBe(false);
    expect(newCache.get('commit2')).toEqual([
      { name: 'v1.0.0', hash: 'commit2', version: undefined },
    ]);
  });

  it('updates multiple tags', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);
    const updatedTags: TagInfo[] = [
      { name: 'v1.0.0', hash: 'commit3', version: undefined },
      { name: 'v1.1.0', hash: 'commit3', version: undefined },
    ];

    const newCache = updateTagsInCache(
      cache,
      ['v1.0.0', 'v1.1.0'],
      updatedTags
    );

    expect(newCache.has('commit1')).toBe(false);
    expect(newCache.has('commit2')).toBe(false);
    expect(newCache.get('commit3')).toHaveLength(2);
  });

  it('preserves other tags on same commits', () => {
    const cache = new Map<string, TagInfo[]>([
      [
        'commit1',
        [
          { name: 'v1.0.0', hash: 'commit1', version: undefined },
          { name: 'release-1.0', hash: 'commit1', version: undefined },
        ],
      ],
    ]);
    const updatedTags: TagInfo[] = [
      { name: 'v1.0.0', hash: 'commit2', version: undefined },
    ];

    const newCache = updateTagsInCache(cache, ['v1.0.0'], updatedTags);

    expect(newCache.get('commit1')).toEqual([
      { name: 'release-1.0', hash: 'commit1', version: undefined },
    ]);
    expect(newCache.get('commit2')).toEqual([
      { name: 'v1.0.0', hash: 'commit2', version: undefined },
    ]);
  });
});

describe('findTagInCache', () => {
  it('finds existing tag', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);

    const tag = findTagInCache(cache, 'v1.0.0');

    expect(tag).toEqual({
      name: 'v1.0.0',
      hash: 'commit1',
      version: undefined,
    });
  });

  it('returns undefined for non-existent tag', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);

    const tag = findTagInCache(cache, 'v2.0.0');

    expect(tag).toBeUndefined();
  });

  it('finds tag among multiple commits', () => {
    const cache = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const tag = findTagInCache(cache, 'v1.1.0');

    expect(tag).toEqual({
      name: 'v1.1.0',
      hash: 'commit2',
      version: undefined,
    });
  });
});

describe('getAllTagNames', () => {
  it('returns all tag names', () => {
    const cache = new Map<string, TagInfo[]>([
      [
        'commit1',
        [
          { name: 'v1.0.0', hash: 'commit1', version: undefined },
          { name: 'release-1.0', hash: 'commit1', version: undefined },
        ],
      ],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const names = getAllTagNames(cache);

    expect(names).toHaveLength(3);
    expect(names).toContain('v1.0.0');
    expect(names).toContain('release-1.0');
    expect(names).toContain('v1.1.0');
  });

  it('returns empty array for empty cache', () => {
    const cache = new Map<string, TagInfo[]>();

    const names = getAllTagNames(cache);

    expect(names).toEqual([]);
  });
});

describe('countTags', () => {
  it('counts all tags', () => {
    const cache = new Map<string, TagInfo[]>([
      [
        'commit1',
        [
          { name: 'v1.0.0', hash: 'commit1', version: undefined },
          { name: 'release-1.0', hash: 'commit1', version: undefined },
        ],
      ],
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const count = countTags(cache);

    expect(count).toBe(3);
  });

  it('returns 0 for empty cache', () => {
    const cache = new Map<string, TagInfo[]>();

    const count = countTags(cache);

    expect(count).toBe(0);
  });
});

describe('mergeCaches', () => {
  it('merges two non-overlapping caches', () => {
    const cache1 = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const cache2 = new Map<string, TagInfo[]>([
      ['commit2', [{ name: 'v1.1.0', hash: 'commit2', version: undefined }]],
    ]);

    const merged = mergeCaches(cache1, cache2);

    expect(merged.size).toBe(2);
    expect(merged.get('commit1')).toEqual([
      { name: 'v1.0.0', hash: 'commit1', version: undefined },
    ]);
    expect(merged.get('commit2')).toEqual([
      { name: 'v1.1.0', hash: 'commit2', version: undefined },
    ]);
  });

  it('merges caches with same commit', () => {
    const cache1 = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const cache2 = new Map<string, TagInfo[]>([
      [
        'commit1',
        [{ name: 'release-1.0', hash: 'commit1', version: undefined }],
      ],
    ]);

    const merged = mergeCaches(cache1, cache2);

    expect(merged.get('commit1')).toHaveLength(2);
  });

  it('does not duplicate tags with same name', () => {
    const cache1 = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);
    const cache2 = new Map<string, TagInfo[]>([
      ['commit1', [{ name: 'v1.0.0', hash: 'commit1', version: undefined }]],
    ]);

    const merged = mergeCaches(cache1, cache2);

    expect(merged.get('commit1')).toHaveLength(1);
  });
});
