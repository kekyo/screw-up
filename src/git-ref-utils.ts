// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import fs, { readFile, stat } from 'fs/promises';
import git from 'isomorphic-git';
import { isAbsolute, join } from 'path';

//////////////////////////////////////////////////////////////////////////////////

/**
 * Resolve the actual Git directory for repositories, worktrees, and submodules.
 * @param repoPath - Repository path
 * @returns The resolved Git directory path
 */
export const getActualGitDir = async (repoPath: string): Promise<string> => {
  const gitDir = join(repoPath, '.git');
  const gitStat = await stat(gitDir).catch(() => null);

  if (!gitStat?.isFile()) {
    return gitDir;
  }

  const content = await readFile(gitDir, 'utf-8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    return gitDir;
  }

  return isAbsolute(match[1]) ? match[1] : join(repoPath, match[1]);
};

/**
 * Resolve a tag object OID to the commit OID it ultimately points to.
 * Lightweight tags are returned unchanged.
 * @param repoPath - Repository path
 * @param tagOid - Tag or commit OID
 * @returns Commit hash this tag points to
 */
export const resolveTagOidToCommit = async (
  repoPath: string,
  tagOid: string
): Promise<string> => {
  try {
    const tagObject = await git.readTag({
      fs,
      dir: repoPath,
      oid: tagOid,
    });

    if (tagObject?.tag?.object) {
      return tagObject.tag.object;
    }
  } catch {
    // Lightweight tags are already commit OIDs.
  }

  return tagOid;
};
