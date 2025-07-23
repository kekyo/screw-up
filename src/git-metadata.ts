// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { simpleGit } from 'simple-git';
import dayjs from 'dayjs';
import { GitMetadata } from './types.js';

// Ported from: https://github.com/kekyo/RelaxVersioner/blob/master/RelaxVersioner.Core/Analyzer.cs

/**
 * Version information
 */
interface Version {
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
}

/**
 * Tag information
 */
interface TagInfo {
  name: string;
  hash: string;
  version: Version;
}

/////////////////////////////////////////////////////////////////////////////////

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

  const version: Version = {
    major: parseInt(match[1], 10),
    original: tagName
  };

  if (match[2] !== undefined) {
    version.minor = parseInt(match[2], 10);
  }
  if (match[3] !== undefined) {
    version.build = parseInt(match[3], 10);
  }
  if (match[4] !== undefined) {
    version.revision = parseInt(match[4], 10);
  }

  return version;
};

/**
 * Check if a version is valid
 * @param version - The version to check
 * @returns True if the version is valid, false otherwise
 */
const isValidVersion = (version: Version): boolean => {
  // RelaxVersioner requires at least major component and optionally minor
  return version.major >= 0 && (version.minor === undefined || version.minor >= 0);
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
  // RelaxVersioner increment logic: increment the rightmost existing component
  if (version.revision !== undefined) {
    return { ...version, revision: version.revision + 1 };
  }
  if (version.build !== undefined) {
    return { ...version, build: version.build + 1 };
  }
  if (version.minor !== undefined) {
    return { ...version, minor: version.minor + 1 };
  }
  
  // If only major exists, increment major (RelaxVersioner behavior)
  return { 
    ...version, 
    major: version.major + 1,
    original: `${version.major + 1}`
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
 * Check if a directory is a Git repository
 * @param repositoryPath - Local Git repository directory
 * @returns True if the directory is a Git repository, false otherwise
 */
const isGitRepository = async (repositoryPath: string): Promise<boolean> => {
  try {
    const git = simpleGit(repositoryPath);
    await git.status();
    return true;
  } catch {
    return false;
  }
};

/**
 * Get a commit by hash
 * @param repositoryPath - Local Git repository directory
 * @param hash - The hash of the commit
 * @returns The commit or undefined if the commit is not found
 */
const getCommit = async (repositoryPath: string, hash: string): Promise<CommitInfo | undefined> => {
  try {
    const git = simpleGit(repositoryPath);
    const log = await git.show([hash, '--format=%H%n%h%n%ci%n%s%n%P', '-s']);
    const lines = log.trim().split('\n');
    
    if (lines.length < 4) return undefined;
    
    return {
      hash: lines[0],
      shortHash: lines[1],
      date: lines[2],
      message: lines[3],
      parents: lines[4] ? lines[4].split(' ').filter(p => p.length > 0) : []
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
const getCurrentCommit = async (repositoryPath: string): Promise<CommitInfo | undefined> => {
  try {
    const git = simpleGit(repositoryPath);
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) return undefined;

    return {
      hash: log.latest.hash,
      shortHash: log.latest.hash.substring(0, 7),
      date: log.latest.date,
      message: log.latest.message,
      parents: log.latest.refs ? [] : [] // simple-git doesn't provide parent info directly
    };
  } catch {
    return undefined;
  }
};

/**
 * Get related tags for a commit
 * @param repositoryPath - Local Git repository directory
 * @param commitHash - The hash of the commit
 * @returns The related tags or an empty array if no tags are found
 */
const getRelatedTags = async (repositoryPath: string, commitHash: string): Promise<TagInfo[]> => {
  try {
    const git = simpleGit(repositoryPath);
    
    // Get all tags that point to this commit
    const tagsOutput = await git.raw(['tag', '--points-at', commitHash]);
    const tagNames = tagsOutput.trim().split('\n').filter(name => name.length > 0);
    
    const tagInfos: TagInfo[] = [];
    
    for (const tagName of tagNames) {
      const version = parseVersion(tagName);
      if (version && isValidVersion(version)) {
        tagInfos.push({
          name: tagName,
          hash: commitHash,
          version
        });
      } else {
        tagInfos.push({
          name: tagName,
          hash: commitHash,
          version: undefined
        });
      }
    }
    
    // Sort by name
    return tagInfos.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

/**
 * Get related tags for versioning
 * @param repositoryPath - Local Git repository directory
 * @param commitHash - The hash of the commit
 * @returns The related tags or an empty array if no tags are found
 */
const getRelatedTagsForVersioning = async (repositoryPath: string, commitHash: string): Promise<TagInfo[]> => {
  try {
    const git = simpleGit(repositoryPath);
    
    // Get all tags that point to this commit
    const tagsOutput = await git.raw(['tag', '--points-at', commitHash]);
    const tagNames = tagsOutput.trim().split('\n').filter(name => name.length > 0);
    
    const tagInfos: TagInfo[] = [];
    
    for (const tagName of tagNames) {
      const version = parseVersion(tagName);
      if (version && isValidVersion(version)) {
        tagInfos.push({
          name: tagName,
          hash: commitHash,
          version
        });
      }
    }
    
    // Sort by version descending
    return tagInfos.sort((a, b) => compareVersions(a.version, b.version));
  } catch {
    return [];
  }
};

/**
 * Get the commit related branch name.
 * @param repositoryPath - Local Git repository directory
 * @param commitHash - The hash of the commit
 * @returns The commit related branch name or undefined if not found
 */
const getRelatedBranches = async (repositoryPath: string, commitHash: string): Promise<string[]> => {
  try {
    const git = simpleGit(repositoryPath);
    
    // Get all branches that contain this commit
    const branchesOutput = await git.raw(['branch', '-a', '--contains', commitHash]);
    const branches = branchesOutput
      .trim()
      .split('\n')
      .map(branch => branch.replace(/^\*?\s*/, '').trim())
      .filter(branch => branch.length > 0 && !branch.startsWith('('))
      .filter((branch, index, arr) => arr.indexOf(branch) === index); // Remove duplicates

    return branches;
  } catch {
    return [];
  }
};

/**
 * Check if the repository has modified files.
 * @param repositoryPath - Local Git repository directory
 * @returns True if the repository has modified files, false otherwise
 */
const hasModifiedFiles = async (repositoryPath: string): Promise<boolean> => {
  try {
    const git = simpleGit(repositoryPath);
    const status = await git.status();
    return status.modified.length > 0 || status.not_added.length > 0 || status.deleted.length > 0;
  } catch {
    return false;
  }
};

/////////////////////////////////////////////////////////////////////////////////

/**
 * Lookup version label recursively
 * @param cwd - The directory to check
 * @param commit - The commit to lookup
 * @param reachedCommits - The map of reached commits
 * @returns The version or undefined if no version is found
 */
const lookupVersionLabelRecursive = async (
  cwd: string,
  commit: CommitInfo,
  reachedCommits: Map<string, Version>
): Promise<Version | undefined> => {
  // Check if we've already processed this commit
  if (reachedCommits.has(commit.hash)) {
    return reachedCommits.get(commit.hash);
  }

  // Get tags associated with this commit
  const relatedTags = await getRelatedTagsForVersioning(cwd, commit.hash);
  
  if (relatedTags.length > 0) {
    // Found tags, use the highest version
    const highestVersion = relatedTags[0].version;
    reachedCommits.set(commit.hash, highestVersion);
    return highestVersion;
  }

  // No tags found, explore parent commits
  let bestVersion: Version | undefined = undefined;
  
  // Get parent commits
  const git = simpleGit(cwd);
  try {
    const parents = await git.raw(['log', '--format=%P', '-n', '1', commit.hash]);
    const parentHashes = parents.trim().split(' ').filter(h => h.length > 0);
    
    for (const parentHash of parentHashes) {
      const parentCommit = await getCommit(cwd, parentHash);
      if (parentCommit) {
        const parentVersion = await lookupVersionLabelRecursive(cwd, parentCommit, reachedCommits);
        if (parentVersion) {
          if (!bestVersion || compareVersions(parentVersion, bestVersion) < 0) {
            bestVersion = parentVersion;
          }
        }
      }
    }
  } catch {
    // If we can't get parent information, return undefined
  }

  if (bestVersion) {
    // Increment the best version found in parents
    const incrementedVersion = incrementLastVersionComponent(bestVersion);
    reachedCommits.set(commit.hash, incrementedVersion);
    return incrementedVersion;
  }

  // No version found in parent hierarchy, use default
  const defaultVersion: Version = { major: 0, minor: 0, build: 1, original: '0.0.1' };
  reachedCommits.set(commit.hash, defaultVersion);
  return defaultVersion;
};

/////////////////////////////////////////////////////////////////////////////////

/**
 * Get default Git metadata from local repository.
 * @param repositoryPath - Local Git repository directory
 * @param checkWorkingDirectoryStatus - Check working directory status to increase version
 * @returns The metadata object with git metadata
 */
export const getGitMetadata = async (repositoryPath: string, checkWorkingDirectoryStatus: boolean) => {
  const metadata: any = {};

  if (!(await isGitRepository(repositoryPath))) {
    return metadata;
  }

  try {
    // Get current commit
    const currentCommit = await getCurrentCommit(repositoryPath);
    if (!currentCommit) {
      return metadata;
    }

    // Initialize reached commits cache
    const reachedCommits = new Map<string, Version>();

    // Lookup version using RelaxVersioner algorithm
    let version = await lookupVersionLabelRecursive(repositoryPath, currentCommit, reachedCommits);
    
    // Set git metadata into 'git' key
    const gitMetadata: GitMetadata = { tags: [], branches: [] };
    metadata.git = gitMetadata;

    if (version) {
      // Check for working directory changes and increment version if needed (RelaxVersioner behavior)
      const hasModified = checkWorkingDirectoryStatus && await hasModifiedFiles(repositoryPath);
      if (hasModified) {
        version = incrementLastVersionComponent(version);
      }

      const gitVersion = formatVersion(version);
      gitMetadata.version = gitVersion;
      metadata.version = gitVersion;     // Fallback default version metadata
    }

    // Set commit information
    gitMetadata.commit = {
      hash: currentCommit.hash,
      shortHash: currentCommit.shortHash,
      date: dayjs(currentCommit.date).format('YYYY-MM-DDTHH:mm:ssZ[Z]'),
      message: currentCommit.message
    };

    // Try to find the actual tag name if it exists
    const relatedTags = await getRelatedTags(repositoryPath, currentCommit.hash);
    gitMetadata.tags = relatedTags.map(tag => tag.name);

    // Get branch information
    const relatedBranches = await getRelatedBranches(repositoryPath, currentCommit.hash);
    gitMetadata.branches = relatedBranches;
  } catch (error) {
    // If any error occurs, return empty metadata
    console.warn('Failed to extract git metadata:', error);
  }

  return metadata;
};
