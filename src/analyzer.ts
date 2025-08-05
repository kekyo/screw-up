// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import * as git from 'isomorphic-git';
import * as fs from 'fs/promises';
import dayjs from 'dayjs';
import { GitMetadata } from './types.js';
import { Logger } from './internal.js';

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
  return (num < 0 || num > 65535) ? undefined : num;
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
    original: tagName
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
 * Get a commit by hash
 * @param repositoryPath - Local Git repository directory
 * @param hash - The hash of the commit
 * @returns The commit or undefined if the commit is not found
 */
const getCommit = async (repositoryPath: string, hash: string): Promise<CommitInfo | undefined> => {
  try {
    const commit = await git.readCommit({ fs, dir: repositoryPath, oid: hash });
    
    return {
      hash: commit.oid,
      shortHash: commit.oid.substring(0, 7),
      date: new Date(commit.commit.author.timestamp * 1000).toISOString(),
      message: commit.commit.message.trim(),
      parents: commit.commit.parent || []
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
    const currentOid = await git.resolveRef({ fs, dir: repositoryPath, ref: 'HEAD' });
    const commit = await git.readCommit({ fs, dir: repositoryPath, oid: currentOid });

    return {
      hash: commit.oid,
      shortHash: commit.oid.substring(0, 7),
      date: new Date(commit.commit.author.timestamp * 1000).toISOString(),
      message: commit.commit.message.trim(),
      parents: commit.commit.parent || []
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
    const tags = await git.listTags({ fs, dir: repositoryPath });
    const tagInfos: TagInfo[] = [];
    
    for (const tagName of tags) {
      try {
        const tagOid = await git.resolveRef({ fs, dir: repositoryPath, ref: `refs/tags/${tagName}` });
        if (tagOid === commitHash) {
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
      } catch {
        // Skip tags that can't be resolved
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
    const tags = await git.listTags({ fs, dir: repositoryPath });
    const tagInfos: TagInfo[] = [];
    
    for (const tagName of tags) {
      try {
        const tagOid = await git.resolveRef({ fs, dir: repositoryPath, ref: `refs/tags/${tagName}` });
        if (tagOid === commitHash) {
          const version = parseVersion(tagName);
          if (version && isValidVersion(version)) {
            tagInfos.push({
              name: tagName,
              hash: commitHash,
              version
            });
          }
        }
      } catch {
        // Skip tags that can't be resolved
      }
    }
    return tagInfos;
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
    const branches = await git.listBranches({ fs, dir: repositoryPath });
    const relatedBranches: string[] = [];
    
    for (const branch of branches) {
      try {
        // Check if the branch HEAD points to the specified commit
        const branchOid = await git.resolveRef({ fs, dir: repositoryPath, ref: branch });
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

/**
 * Check if the repository has modified files (following RelaxVersioner logic).
 * Checks for staged files, unstaged files, and untracked files (respecting .gitignore).
 * @param repositoryPath - Local Git repository directory
 * @returns True if the repository has modified files, false otherwise
 */
const hasModifiedFiles = async (repositoryPath: string): Promise<boolean> => {
  try {
    const status = await git.statusMatrix({ fs, dir: repositoryPath });
    // statusMatrix returns [filepath, headStatus, workdirStatus, stageStatus]
    // headStatus: 0=absent, 1=present
    // workdirStatus: 0=absent, 1=present, 2=modified
    // stageStatus: 0=absent, 1=present, 2=modified, 3=added
    // By default, ignored files are excluded (ignored: false)
    return status.some(([, head, workdir, stage]) => 
      workdir === 2 ||     // modified in working directory (unstaged)
      stage === 2 ||       // modified in stage (staged)  
      stage === 3 ||       // added to stage (staged)
      (head === 1 && workdir === 0) ||  // deleted from working directory
      (head === 0 && workdir === 1)     // untracked files (respecting .gitignore)
    );
  } catch {
    return false;
  }
};

/**
 * Get untracked files respecting .gitignore
 * @param repositoryPath - Local Git repository directory
 * @returns Array of untracked file paths
 */
const getUntrackedFiles = async (repositoryPath: string): Promise<string[]> => {
  try {
    const status = await git.statusMatrix({ fs, dir: repositoryPath });
    return status
      .filter(([, head, workdir]) => head === 0 && workdir === 1)  // untracked files
      .map(([filepath]) => filepath);
  } catch {
    return [];
  }
};

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
 * @returns The version or undefined if no version is found
 */
const lookupVersionLabelRecursive = async (
  cwd: string,
  commit: CommitInfo,
  reachedCommits: Map<string, Version>
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
    const relatedTags = await getRelatedTagsForVersioning(cwd, currentCommit.hash);
    const versionCandidates = relatedTags
      .filter(tag => tag.version && isValidVersion(tag.version))
      .filter(tag => tag.version!.minor !== undefined)   // "1.2" or more.
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
      const commitObj = await git.readCommit({ fs, dir: cwd, oid: currentCommit.hash });
      const parentHashes = commitObj.commit.parent || [];
      parentCommits =
        (await Promise.all(parentHashes.map(parentHash => getCommit(cwd, parentHash)))).
        filter(ci => ci !== undefined);
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
        const alternateParentVersion = await lookupVersionLabelRecursive(cwd, parents[index], reachedCommits);
        if (alternateParentVersion && compareVersions(alternateParentVersion, version) < 0) {
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
  repositoryPath: string, checkWorkingDirectoryStatus: boolean, logger: Logger) => {
  const metadata: any = {};

  // Try to find git root directory from the given path
  let gitRootPath: string;
  try {
    gitRootPath = await git.findRoot({ fs, filepath: repositoryPath });
  } catch {
    // No git repository found
    return metadata;
  }

  try {
    // Get current commit
    const currentCommit = await getCurrentCommit(gitRootPath);
    if (!currentCommit) {
      return metadata;
    }

    // Initialize reached commits cache
    const reachedCommits = new Map<string, Version>();

    // Lookup version
    let version = await lookupVersionLabelRecursive(gitRootPath, currentCommit, reachedCommits);
    
    // Set git metadata into 'git' key
    const gitMetadata: GitMetadata = { tags: [], branches: [] };
    metadata.git = gitMetadata;

    if (version) {
      // Check for working directory changes and increment version if needed
      const hasModified = checkWorkingDirectoryStatus && await hasModifiedFiles(gitRootPath);
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
    const relatedTags = await getRelatedTags(gitRootPath, currentCommit.hash);
    gitMetadata.tags = relatedTags.map(tag => tag.name);

    // Get branch information
    const relatedBranches = await getRelatedBranches(gitRootPath, currentCommit.hash);
    gitMetadata.branches = relatedBranches;
  } catch (error) {
    // If any error occurs, return empty metadata
    logger.warn(`Failed to extract git metadata: ${error}`);
  }

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
  targetDir: string, checkWorkingDirectoryStatus: boolean, logger: Logger) => {
  let cachedMetadata: any;
  return async () => {
    if (!cachedMetadata) {
      cachedMetadata = await getGitMetadata(
        targetDir, checkWorkingDirectoryStatus, logger);
    }
    return cachedMetadata;
  };
}
