// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import * as git from 'isomorphic-git';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { join } from 'path';
import { GitMetadata } from './types';
import { Logger } from './internal';
import { buildCompleteTagCache } from './git-operations';
import { getActualGitDir, listTreeFiles } from './git-ref-utils';

//////////////////////////////////////////////////////////////////////////////////

// Ported from: https://github.com/kekyo/RelaxVersioner/blob/master/RelaxVersioner.Core/Analyzer.cs

/**
 * Version information
 */
export interface Version {
  major: number;
  minor?: number;
  build?: number;
  revision?: number;
  original: string;
}

/**
 * Primitive commit information
 */
interface CommitInfo {
  hash: string;
  shortHash: string;
  date: string;
  message: string;
  parents: string[];
  tree: string;
}

/**
 * Tag information
 */
export interface TagInfo {
  name: string;
  hash: string;
  version: Version | undefined;
}

/////////////////////////////////////////////////////////////////////////////////

/**
 * Parse and validate a version component
 * @param value - The string value to parse
 * @returns The parsed number or undefined if invalid (negative or > 65535)
 */
const parseVersionComponent = (value: string): number | undefined => {
  const num = parseInt(value, 10);
  return num < 0 || num > 65535 ? undefined : num;
};

/**
 * Parse a version tag name
 * @param tagName - The version tag name
 * @returns The parsed version or undefined if the tag name is invalid
 */
const parseVersion = (tagName: string): Version | undefined => {
  // Remove common prefix 'v'.
  const cleanTag = tagName.replace(/^v/i, '');

  // Match version pattern: major.minor[.build[.revision]].
  const versionRegex = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/;
  const match = cleanTag.match(versionRegex);

  if (!match) {
    return undefined;
  }

  const major = parseVersionComponent(match[1]);
  if (major === undefined) {
    return undefined;
  }

  const version: Version = {
    major,
    original: tagName,
  };

  if (match[2] !== undefined) {
    const minor = parseVersionComponent(match[2]);
    if (minor === undefined) {
      return undefined;
    }
    version.minor = minor;
  }
  if (match[3] !== undefined) {
    const build = parseVersionComponent(match[3]);
    if (build === undefined) {
      return undefined;
    }
    version.build = build;
  }
  if (match[4] !== undefined) {
    const revision = parseVersionComponent(match[4]);
    if (revision === undefined) {
      return undefined;
    }
    version.revision = revision;
  }

  return version;
};

/**
 * Check if a version is valid
 * @param version - The version to check
 * @returns True if the version is valid, false otherwise
 */
const isValidVersion = (version: Version): boolean => {
  // At least major component and optionally minor
  return (
    version.major >= 0 && (version.minor === undefined || version.minor >= 0)
  );
};

/**
 * Compare two versions
 * @param a - The first version
 * @param b - The second version
 * @returns A negative number if a is less than b, a positive number if a is greater than b, or 0 if they are equal
 */
const compareVersions = (a: Version, b: Version): number => {
  // Compare major
  if (a.major !== b.major) return b.major - a.major;

  // Compare minor (treat undefined as 0)
  const aMinor = a.minor ?? 0;
  const bMinor = b.minor ?? 0;
  if (aMinor !== bMinor) return bMinor - aMinor;

  // Compare build (treat undefined as 0)
  const aBuild = a.build ?? 0;
  const bBuild = b.build ?? 0;
  if (aBuild !== bBuild) return bBuild - aBuild;

  // Compare revision (treat undefined as 0)
  const aRevision = a.revision ?? 0;
  const bRevision = b.revision ?? 0;
  if (aRevision !== bRevision) return bRevision - aRevision;

  return 0;
};

/**
 * Increment the last version component
 * @param version - The version to increment
 * @returns The incremented version
 */
const incrementLastVersionComponent = (version: Version): Version => {
  // Increment the rightmost existing component
  if (version.revision !== undefined) {
    return { ...version, revision: version.revision + 1 };
  }
  if (version.build !== undefined) {
    return { ...version, build: version.build + 1 };
  }
  if (version.minor !== undefined) {
    return { ...version, minor: version.minor + 1 };
  }

  // If only major exists, increment major
  return {
    ...version,
    major: version.major + 1,
    original: `${version.major + 1}`,
  };
};

/**
 * Format a version
 * @param version - The version to format
 * @returns The formatted version
 */
const formatVersion = (version: Version): string => {
  let result = `${version.major}`;

  if (version.minor !== undefined) {
    result += `.${version.minor}`;

    if (version.build !== undefined) {
      result += `.${version.build}`;

      if (version.revision !== undefined) {
        result += `.${version.revision}`;
      }
    }
  }

  return result;
};

/////////////////////////////////////////////////////////////////////////////////

/**
 * Get a commit by hash
 * @param repositoryPath - Local Git repository directory
 * @param hash - The hash of the commit
 * @returns The commit or undefined if the commit is not found
 */
const getCommit = async (
  repositoryPath: string,
  hash: string
): Promise<CommitInfo | undefined> => {
  try {
    const commit = await git.readCommit({ fs, dir: repositoryPath, oid: hash });

    return {
      hash: commit.oid,
      shortHash: commit.oid.substring(0, 7),
      date: new Date(commit.commit.author.timestamp * 1000).toISOString(),
      message: commit.commit.message.trim(),
      parents: commit.commit.parent || [],
      tree: commit.commit.tree,
    };
  } catch {
    return undefined;
  }
};

/**
 * Get the current commit
 * @param repositoryPath - Local Git repository directory
 * @returns The current commit or undefined if the current commit is not found
 */
const getCurrentCommit = async (
  repositoryPath: string
): Promise<CommitInfo | undefined> => {
  try {
    const currentOid = await git.resolveRef({
      fs,
      dir: repositoryPath,
      ref: 'HEAD',
    });
    const commit = await git.readCommit({
      fs,
      dir: repositoryPath,
      oid: currentOid,
    });

    return {
      hash: commit.oid,
      shortHash: commit.oid.substring(0, 7),
      date: new Date(commit.commit.author.timestamp * 1000).toISOString(),
      message: commit.commit.message.trim(),
      parents: commit.commit.parent || [],
      tree: commit.commit.tree,
    };
  } catch {
    return undefined;
  }
};

/**
 * Get related tags from commit map
 * @param commitToTags - Map of commit hash to tags
 * @param commitHash - The hash of the commit
 * @returns The related tags or an empty array if no tags are found
 */
const getRelatedTagsFromMap = (
  commitToTags: Map<string, TagInfo[]>,
  commitHash: string
): TagInfo[] => {
  return commitToTags.get(commitHash) || [];
};

// Removed: getRelatedTags and getRelatedTagsForVersioning functions are no longer needed as we use the commit map directly

/**
 * Get the commit related branch name.
 * @param repositoryPath - Local Git repository directory
 * @param commitHash - The hash of the commit
 * @returns The commit related branch name or undefined if not found
 */
const getRelatedBranches = async (
  repositoryPath: string,
  commitHash: string
): Promise<string[]> => {
  try {
    const branches = await git.listBranches({ fs, dir: repositoryPath });
    const relatedBranches: string[] = [];

    for (const branch of branches) {
      try {
        // Check if the branch HEAD points to the specified commit
        const branchOid = await git.resolveRef({
          fs,
          dir: repositoryPath,
          ref: branch,
        });
        if (branchOid === commitHash) {
          relatedBranches.push(branch);
        }
      } catch {
        // Skip branches that can't be resolved
      }
    }

    return relatedBranches;
  } catch {
    return [];
  }
};

interface GitIndexEntry {
  path: string;
  oid: string;
  size: number;
  stage: number;
}

interface ModifiedFileInfo {
  path: string;
  reason: 'staged' | 'worktree' | 'untracked';
}

const parseGitIndex = async (
  gitDir: string
): Promise<Map<string, GitIndexEntry>> => {
  try {
    const buffer = await fs.readFile(join(gitDir, 'index'));
    if (buffer.subarray(0, 4).toString('ascii') !== 'DIRC') {
      throw new Error('Unsupported git index signature');
    }

    const version = buffer.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      throw new Error(`Unsupported git index version: ${version}`);
    }

    const entryCount = buffer.readUInt32BE(8);
    let offset = 12;
    const entries = new Map<string, GitIndexEntry>();

    for (let index = 0; index < entryCount; index++) {
      const entryStart = offset;
      const size = buffer.readUInt32BE(entryStart + 36);
      const oid = buffer
        .subarray(entryStart + 40, entryStart + 60)
        .toString('hex');
      const flags = buffer.readUInt16BE(entryStart + 60);
      const stage = (flags >> 12) & 0x3;

      offset = entryStart + 62;
      if (version >= 3 && (flags & 0x4000) !== 0) {
        offset += 2;
      }

      const pathEnd = buffer.indexOf(0x00, offset);
      if (pathEnd < 0) {
        throw new Error('Invalid git index path entry');
      }

      const path = buffer.subarray(offset, pathEnd).toString('utf-8');
      offset = pathEnd + 1;
      while ((offset - entryStart) % 8 !== 0) {
        offset += 1;
      }

      entries.set(path, {
        path,
        oid,
        size,
        stage,
      });
    }

    return entries;
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return new Map<string, GitIndexEntry>();
    }
    throw error;
  }
};

const listTrackedDirectories = (
  indexEntries: Map<string, GitIndexEntry>
): Set<string> => {
  const directories = new Set<string>(['']);

  for (const path of indexEntries.keys()) {
    const segments = path.split('/');
    let currentPath = '';
    for (let index = 0; index < segments.length - 1; index++) {
      currentPath = currentPath
        ? `${currentPath}/${segments[index]}`
        : segments[index];
      directories.add(currentPath);
    }
  }

  return directories;
};

const listWorkingDirectoryFiles = async (
  repositoryPath: string,
  trackedDirectories: Set<string>,
  relativePath: string = ''
): Promise<string[]> => {
  const directoryPath = relativePath
    ? join(repositoryPath, relativePath)
    : repositoryPath;
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }

    const entryPath = relativePath
      ? `${relativePath}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      if (!trackedDirectories.has(entryPath)) {
        const ignored = await git.isIgnored({
          fs,
          dir: repositoryPath,
          filepath: entryPath,
        });
        if (ignored) {
          continue;
        }
      }

      files.push(
        ...(await listWorkingDirectoryFiles(
          repositoryPath,
          trackedDirectories,
          entryPath
        ))
      );
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    }
  }

  return files;
};

const calculateBlobOid = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath);
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
};

const getModifiedFiles = async (
  repositoryPath: string,
  headTreeOid: string
): Promise<ModifiedFileInfo[]> => {
  try {
    const gitDir = await getActualGitDir(repositoryPath);
    const [headFiles, indexEntries] = await Promise.all([
      listTreeFiles(repositoryPath, headTreeOid),
      parseGitIndex(gitDir),
    ]);
    const trackedDirectories = listTrackedDirectories(indexEntries);
    const workdirFiles = await listWorkingDirectoryFiles(
      repositoryPath,
      trackedDirectories
    );
    const modifiedFiles = new Map<string, ModifiedFileInfo>();

    const rememberModifiedFile = (
      path: string,
      reason: ModifiedFileInfo['reason']
    ) => {
      if (!modifiedFiles.has(path)) {
        modifiedFiles.set(path, { path, reason });
      }
    };

    for (const [path, headOid] of headFiles.entries()) {
      const indexEntry = indexEntries.get(path);
      if (!indexEntry) {
        rememberModifiedFile(path, 'staged');
      } else if (indexEntry.stage !== 0 || indexEntry.oid !== headOid) {
        rememberModifiedFile(path, 'staged');
      }
    }

    for (const indexEntry of indexEntries.values()) {
      if (!headFiles.has(indexEntry.path)) {
        rememberModifiedFile(indexEntry.path, 'staged');
      }

      const absolutePath = join(repositoryPath, indexEntry.path);
      try {
        const stats = await fs.lstat(absolutePath);
        if (!stats.isFile() && !stats.isSymbolicLink()) {
          rememberModifiedFile(indexEntry.path, 'worktree');
          continue;
        }

        if (indexEntry.stage !== 0) {
          rememberModifiedFile(indexEntry.path, 'staged');
          continue;
        }

        if (
          indexEntry.size !== stats.size ||
          (await calculateBlobOid(absolutePath)) !== indexEntry.oid
        ) {
          rememberModifiedFile(indexEntry.path, 'worktree');
        }
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          rememberModifiedFile(indexEntry.path, 'worktree');
          continue;
        }
        throw error;
      }
    }

    const trackedPaths = new Set(indexEntries.keys());
    for (const filepath of workdirFiles) {
      if (trackedPaths.has(filepath)) {
        continue;
      }

      const ignored = await git.isIgnored({
        fs,
        dir: repositoryPath,
        filepath,
      });
      if (!ignored) {
        rememberModifiedFile(filepath, 'untracked');
      }
    }

    return Array.from(modifiedFiles.values());
  } catch {
    return [];
  }
};

const formatModifiedFile = (modifiedFile: ModifiedFileInfo) =>
  `'${modifiedFile.path}':${modifiedFile.reason}`;

/////////////////////////////////////////////////////////////////////////////////

/**
 * Scheduled commit
 */
interface ScheduledCommit {
  commit: CommitInfo;
  parents: CommitInfo[];
}

/**
 * Lookup version label recursively core analyzer
 * @param cwd - The directory to check
 * @param commit - The commit to lookup
 * @param reachedCommits - The map of reached commits
 * @param commitToTags - Map of commit hash to tags for performance
 * @returns The version or undefined if no version is found
 */
const lookupVersionLabelRecursive = async (
  cwd: string,
  commit: CommitInfo,
  reachedCommits: Map<string, Version>,
  commitToTags: Map<string, TagInfo[]>
): Promise<Version | undefined> => {
  // Scheduled commit analysis stack
  const scheduledStack: ScheduledCommit[] = [];

  let version: Version = { major: 0, minor: 0, build: 1, original: '0.0.1' };
  let currentCommit = commit;

  // Trace back to the parent commit repeatedly with the following conditions:
  // * If the commit has already been reached, get its version.
  // * If there is a recognizable version string in the tag, get its version.
  // * If the parent commit does not exist, get the default version.
  // * If other than the above, push the commit on the stack for later processing in reverse order.
  while (true) {
    // If the commit has already been reached, get its version.
    if (reachedCommits.has(currentCommit.hash)) {
      version = reachedCommits.get(currentCommit.hash)!;
      break;
    }

    // Detected mostly larger version tag.
    const relatedTags = getRelatedTagsFromMap(commitToTags, currentCommit.hash);
    const versionCandidates = relatedTags
      .filter((tag) => tag.version && isValidVersion(tag.version))
      .filter((tag) => tag.version!.minor !== undefined) // "1.2" or more.
      .sort((a, b) => compareVersions(a.version!, b.version!));
    if (versionCandidates.length >= 1) {
      // Found version tags, use the highest version
      version = versionCandidates[0].version!;
      reachedCommits.set(currentCommit.hash, version);
      break;
    }

    // Get parent commits
    let parentCommits: CommitInfo[] = [];
    try {
      const commitObj = await git.readCommit({
        fs,
        dir: cwd,
        oid: currentCommit.hash,
      });
      const parentHashes = commitObj.commit.parent || [];
      parentCommits = (
        await Promise.all(
          parentHashes.map((parentHash) => getCommit(cwd, parentHash))
        )
      ).filter((ci) => ci !== undefined);
    } catch {
      // If we can't get parent information, use default version
    }
    if (parentCommits.length === 0) {
      // No parents, this is the root commit
      reachedCommits.set(currentCommit.hash, version);
      break;
    }

    // Schedule this commit for later processing
    scheduledStack.push({ commit: currentCommit, parents: parentCommits });

    // Move to the first parent (primary branch)
    currentCommit = parentCommits[0];
  }

  // As long as there are commits stacked on the stack,
  // retrieve a commit from the stack, and if there is more than one parent commit for that commit:
  // * Recursively get versions from parent commits other than the primary one.
  // * Compare the versions obtained and store the largest version.
  // * Increment the version and make it the version of the current commit.
  while (scheduledStack.length >= 1) {
    const scheduled = scheduledStack.pop()!;
    const { commit: scheduledCommit, parents } = scheduled;

    // Handle merge commits (multiple parents)
    if (parents.length >= 2) {
      // Check alternate parent commits (feature branches)
      for (let index = 1; index < parents.length; index++) {
        const alternateParentVersion = await lookupVersionLabelRecursive(
          cwd,
          parents[index],
          reachedCommits,
          commitToTags
        );
        if (
          alternateParentVersion &&
          compareVersions(alternateParentVersion, version) < 0
        ) {
          // Use higher version from alternate parent
          version = alternateParentVersion;
        }
      }
    }

    // Increment version for this commit
    version = incrementLastVersionComponent(version);
    reachedCommits.set(scheduledCommit.hash, version);
  }

  return version;
};

/////////////////////////////////////////////////////////////////////////////////

/**
 * Get default Git metadata from local repository.
 * @param repositoryPath - Local Git repository directory
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @param logger - Logger instance
 * @returns The metadata object with git metadata
 */
const getGitMetadata = async (
  repositoryPath: string,
  checkWorkingDirectoryStatus: boolean,
  logger: Logger
) => {
  const startTime = Date.now();
  const metadata: any = {};

  // Try to find git root directory from the given path
  let gitRootPath: string;
  try {
    gitRootPath = await git.findRoot({ fs, filepath: repositoryPath });
  } catch {
    // No git repository found
    logger.debug(
      `[screw-up] Total getGitMetadata: ${Date.now() - startTime}ms`
    );
    return metadata;
  }

  try {
    // Get current commit
    const currentCommit = await getCurrentCommit(gitRootPath);
    if (!currentCommit) {
      logger.debug(
        `[screw-up] Total getGitMetadata: ${Date.now() - startTime}ms`
      );
      return metadata;
    }

    // Build tag map directly
    const buildStart = Date.now();
    const commitToTags = await buildCompleteTagCache(
      gitRootPath,
      (tagName: string) => {
        const version = parseVersion(tagName);
        return version && isValidVersion(version) ? version : undefined;
      },
      logger
    );
    logger.debug(
      `[screw-up] buildCompleteTagCache: ${Date.now() - buildStart}ms`
    );
    logger.debug(`Built tag map with ${commitToTags.size} commits`);

    // Initialize reached commits cache
    const reachedCommits = new Map<string, Version>();

    // Lookup version
    let version = await lookupVersionLabelRecursive(
      gitRootPath,
      currentCommit,
      reachedCommits,
      commitToTags
    );

    // Set git metadata into 'git' key
    const gitMetadata: GitMetadata = { tags: [], branches: [] };
    metadata.git = gitMetadata;

    if (version) {
      // Check for working directory changes and increment version if needed
      if (checkWorkingDirectoryStatus) {
        const modifiedFiles = await getModifiedFiles(
          gitRootPath,
          currentCommit.tree
        );
        if (modifiedFiles.length >= 1) {
          const newVersion = incrementLastVersionComponent(version);
          logger.debug(
            `Increased git version by detected modified items: ${formatVersion(version)} ---> ${formatVersion(newVersion)}, Files=[${modifiedFiles.map(formatModifiedFile).join(', ')}]`
          );
          version = newVersion;
        }
      }

      const gitVersion = formatVersion(version);
      gitMetadata.version = gitVersion;
      metadata.version = gitVersion; // Fallback default version metadata
    }

    // Set commit information
    gitMetadata.commit = {
      hash: currentCommit.hash,
      shortHash: currentCommit.shortHash,
      date: dayjs(currentCommit.date).format('YYYY-MM-DDTHH:mm:ssZ'),
      message: currentCommit.message,
    };

    // Try to find the actual tag name if it exists
    const relatedTags = getRelatedTagsFromMap(commitToTags, currentCommit.hash);
    gitMetadata.tags = relatedTags.map((tag) => tag.name);

    // Get branch information
    const relatedBranches = await getRelatedBranches(
      gitRootPath,
      currentCommit.hash
    );
    gitMetadata.branches = relatedBranches;
  } catch (error) {
    // If any error occurs, return empty metadata
    logger.warn(`Failed to extract git metadata: ${error}`);
  }

  logger.debug(`[screw-up] Total getGitMetadata: ${Date.now() - startTime}ms`);
  return metadata;
};

//////////////////////////////////////////////////////////////////////////////////

/**
 * Get cached Git metadata fetcher function
 * @param targetDir - Target directory to resolve Git metadata
 * @param checkWorkingDirectoryStatus - Check working directory status
 * @param logger - Logger
 * @returns Git metadata fetcher function
 */
export const getFetchGitMetadata = (
  targetDir: string,
  checkWorkingDirectoryStatus: boolean,
  logger: Logger
) => {
  let cachedMetadata: any;
  return async () => {
    if (!cachedMetadata) {
      cachedMetadata = await getGitMetadata(
        targetDir,
        checkWorkingDirectoryStatus,
        logger
      );
    }
    return cachedMetadata;
  };
};
