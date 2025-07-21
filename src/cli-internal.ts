// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { resolve } from 'path';
import { glob } from 'glob';
import { resolveRawPackageJson } from './internal.js';
import { existsSync, createReadStream, createWriteStream, Stats } from 'fs';
import { mkdir, lstat } from 'fs/promises';
import tar from 'tar-stream';
import zlib from 'zlib';

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
 */
export const packAssets = async (targetDir: string, outputDir: string) : Promise<boolean> => {
  // Check if target directory exists
  if (!existsSync(targetDir)) {
    return false;
  }

  // Resolve package metadata
  const resolvedPackageJson = await resolveRawPackageJson(targetDir);

  // Check if package is private
  if (resolvedPackageJson?.private) {
    return false;
  }

  // Get package name
  const outputFileName = `${resolvedPackageJson?.name ?? "package"}-${resolvedPackageJson?.version ?? "0.0.0"}.tgz`;

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

  return true;
};
