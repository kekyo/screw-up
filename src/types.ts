// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

/**
 * Package metadata (key-value flattenedpairs)
 */
export type PackageMetadata = Record<string, string>;

/**
 * Git metadata
 */
export interface GitMetadata {
  version?: string;
  tags: string[];
  branches: string[];
  commit?: {
    hash: string;
    shortHash: string;
    date: string;
    message: string;
  };
}

/**
 * screw-up options
 */
export interface ScrewUpOptions {
  /**
   * Array of keys to output in banner in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url', 'git.commit.hash']
   */
  outputKeys?: string[];
  /**
   * Array of asset file regex to add banner to
   * @default ['\.d\.ts$']
   */
  assetFilters?: string[];
  /**
   * Enable TypeScript metadata file generation
   * @default false
   */
  outputMetadataFile?: boolean;
  /**
   * Output path for TypeScript metadata file
   * @default 'src/generated/packageMetadata.ts'
   */
  outputMetadataFilePath?: string;
  /**
   * Array of keys to output in metadata file in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url', 'git.commit.hash']
   */
  outputMetadataKeys?: string[];
  /**
   * Check working directory status to increase version
   * @default true
   */
  checkWorkingDirectoryStatus?: boolean;
}
