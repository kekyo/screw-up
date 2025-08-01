// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

/**
 * Logger interface
 */
export interface Logger {
  /**
   * Log an debug message
   * @param msg - The message to log
   */
  readonly debug: (msg: string) => void;
  /**
   * Log an info message
   * @param msg - The message to log
   */
  readonly info: (msg: string) => void;
  /**
   * Log a warning message
   * @param msg - The message to log
   */
  readonly warn: (msg: string) => void;
  /**
   * Log an error message
   * @param msg - The message to log
   */
  readonly error: (msg: string) => void;
}

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
   * Insert metadata banner to output files
   * @default true
   */
  insertMetadataBanner?: boolean;
  /**
   * Array of keys to output in banner in the specified order
   * @default ['name', 'version', 'description', 'author', 'license', 'repository.url', 'git.commit.hash']
   */
  outputKeys?: string[];
  /**
   * Array of asset file regex to add banner to
   * @default ['\.d\.ts$']
   * @remarks Some output source files (includes '*.d.ts') are grouped into "Asset files" and are not included in the output. This option is used to specify the regex of asset files to add banner to.
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
  /**
   * Always override version from Git
   * @default true
   */
  alwaysOverrideVersionFromGit?: boolean;
}
