// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { resolve } from 'path';
import { glob } from 'glob';
import { existsSync, createReadStream, createWriteStream, Stats } from 'fs';
import { mkdir, lstat } from 'fs/promises';
import tar from 'tar-stream';
import zlib from 'zlib';
import { resolveRawPackageJsonObject } from './internal.js';

//////////////////////////////////////////////////////////////////////////////////

const addPackContentEntry = async (pack: tar.Pack, name: string, content: string): Promise<void> => {
  pack.entry({
    name: name,
    type: 'file',
    mode: 0o644,
    mtime: new Date(),
    size: Buffer.byteLength(content, 'utf8')
  }, content);
}

const addPackFileEntry = async (pack: tar.Pack, baseDir: string, path: string, stat: Stats): Promise<void> => {
  const writer = pack.entry({
    name: path,
    mode: stat.mode,
    mtime: stat.mtime,
    size: stat.size
  });
  const stream = createReadStream(resolve(baseDir, path));
  stream.pipe(writer);
  return new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
    writer.on('error', reject);
  });
}

/**
 * Pack assets into a tar archive
 * @param targetDir - Target directory to pack
 * @param outputDir - Output directory to write the tarball
 * @returns Package metadata (package.json) or undefined if failed
 */
export const packAssets = async (targetDir: string, outputDir: string, checkWorkingDirectoryStatus: boolean) : Promise<any> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return undefined;
  }

  // Resolve package metadata
  let resolvedPackageJson: any;
  try {
    resolvedPackageJson = await resolveRawPackageJsonObject(targetDir, checkWorkingDirectoryStatus);
  } catch (error) {
    // If package.json cannot be read (e.g., file doesn't exist), return undefined
    // This matches npm pack behavior which requires package.json
    return undefined;
  }

  // Check if package is private
  if (resolvedPackageJson?.private) {
    return undefined;
  }

  // Get package name
  const outputFileName = `${resolvedPackageJson?.name?.replace('/', '-') ?? "package"}-${resolvedPackageJson?.version ?? "0.0.0"}.tgz`;

  // Create tar packer
  const pack = tar.pack();

  try {
    // Create `package.json` content
    const packageJsonContent = JSON.stringify(resolvedPackageJson, null, 2);
    await addPackContentEntry(pack, 'package.json', packageJsonContent);

    // Get distribution files in `package.json`
    const distributionFileGlobs = resolvedPackageJson?.files as string[] ?? ['**/*'];
    const packingFilePaths = distributionFileGlobs.map(fg => glob.sync(fg, { cwd: targetDir })).flat();

    // Collect target packing files to add to archive
    for (const packingFilePath of packingFilePaths) {
      const fullPath = resolve(targetDir, packingFilePath);

      // Is file regular (except `package.json`)?
      const stat = await lstat(fullPath);
      if (stat.isFile() && packingFilePath !== 'package.json') {
        // Add regular file
        await addPackFileEntry(pack, targetDir, packingFilePath, stat);
      }
    }

    // Finalize tar archive
    pack.finalize();
    
    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true });
    }

    // Compress tar archive
    const outputFile = resolve(outputDir, outputFileName);
    const outputStream = createWriteStream(outputFile);
    const gzip = zlib.createGzip();
    
    // Wait for the stream pipeline to complete
    await new Promise<void>((resolve, reject) => {
      pack.pipe(gzip).pipe(outputStream);
      
      outputStream.on('finish', () => resolve());
      outputStream.on('error', reject);
      pack.on('error', reject);
      gzip.on('error', reject);
    });
  } finally {
    pack.destroy();
  }

  return resolvedPackageJson;
};

//////////////////////////////////////////////////////////////////////////////////

export interface ParsedArgs {
  command?: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args = argv.slice(2); // Remove 'node' and script path
  const result: ParsedArgs = {
    positional: [],
    options: {}
  };

  if (args.length === 0) {
    return result;
  }

  // Don't treat options as command
  if (args[0].startsWith('-')) {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg.startsWith('--')) {
        const optionName = arg.slice(2);
        const nextArg = args[i + 1];

        if (nextArg && !nextArg.startsWith('-')) {
          result.options[optionName] = nextArg;
          i += 2;
        } else {
          result.options[optionName] = true;
          i += 1;
        }
      } else if (arg.startsWith('-')) {
        const optionName = arg.slice(1);
        result.options[optionName] = true;
        i += 1;
      } else {
        result.positional.push(arg);
        i += 1;
      }
    }
    return result;
  }

  result.command = args[0];
  let i = 1;

  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const optionName = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg && !nextArg.startsWith('-')) {
        result.options[optionName] = nextArg;
        i += 2;
      } else {
        result.options[optionName] = true;
        i += 1;
      }
    } else if (arg.startsWith('-')) {
      const optionName = arg.slice(1);
      result.options[optionName] = true;
      i += 1;
    } else {
      result.positional.push(arg);
      i += 1;
    }
  }

  return result;
};
