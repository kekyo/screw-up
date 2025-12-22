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
  tags: readonly string[];
  branches: readonly string[];
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
   * Insert metadata banner to output files
   * @default true
   */
  insertMetadataBanner?: boolean;
  /**
   * Array of keys to output in banner in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url', 'git.commit.hash']
   */
  outputKeys?: readonly string[];
  /**
   * Array of asset file regex to add banner to
   * @default ['\.d\.ts$']
   * @remarks Some output source files (includes '*.d.ts') are grouped into "Asset files" and are not included in the output. This option is used to specify the regex of asset files to add banner to.
   */
  assetFilters?: readonly string[];
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
  outputMetadataKeys?: readonly string[];
  /**
   * Output path for TypeScript metadata type definition file
   * @default outputMetadataFilePath with .d.ts extension
   */
  outputMetadataFileTypePath?: string;
  /**
   * Check working directory status to increase version
   * @default true
   */
  checkWorkingDirectoryStatus?: boolean;
  /**
   * Always override version from Git
   * @default true
   */
  alwaysOverrideVersionFromGit?: boolean;
}
