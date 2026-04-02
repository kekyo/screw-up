// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';

interface PackageJson {
  types?: string;
  exports?: {
    '.': {
      types?: string;
    };
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const repoRoot = process.cwd();
const require = createRequire(import.meta.url);
const tscCliPath = require.resolve('typescript/bin/tsc');

const readPackageJson = (): PackageJson =>
  JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf-8')
  ) as PackageJson;

describe('package manifest', () => {
  it('should expose declarations that resolve from an external consumer', () => {
    const packageJson = readPackageJson();

    expect(packageJson.types).toBe('./dist/src/index.d.ts');
    expect(packageJson.exports?.['.']?.types).toBe(packageJson.types);
    expect(existsSync(join(repoRoot, packageJson.types!))).toBe(true);

    const consumerDir = mkdtempSync(
      join(tmpdir(), 'screw-up-package-manifest-')
    );
    try {
      mkdirSync(join(consumerDir, 'node_modules'), { recursive: true });
      symlinkSync(
        repoRoot,
        join(consumerDir, 'node_modules', 'screw-up'),
        'dir'
      );
      mkdirSync(join(consumerDir, 'src'), { recursive: true });

      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify(
          {
            name: 'consumer',
            private: true,
            type: 'module',
          },
          null,
          2
        )
      );
      writeFileSync(
        join(consumerDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2020',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
            },
            include: ['src'],
          },
          null,
          2
        )
      );
      writeFileSync(
        join(consumerDir, 'src', 'index.ts'),
        `import screwUp, { type ScrewUpOptions } from 'screw-up';

const options: ScrewUpOptions = {
  insertMetadataBanner: true,
};

screwUp(options);
`
      );

      execFileSync(
        process.execPath,
        [tscCliPath, '-p', join(consumerDir, 'tsconfig.json')],
        {
          cwd: consumerDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      );
    } catch (error) {
      const childError = error as {
        message: string;
        stdout?: string;
        stderr?: string;
      };
      throw new Error(
        [childError.message, childError.stdout, childError.stderr]
          .filter((value): value is string => !!value)
          .join('\n')
      );
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });

  it('should declare vite as a peer dependency instead of a runtime dependency', () => {
    const packageJson = readPackageJson();

    expect(packageJson.dependencies?.vite).toBeUndefined();
    expect(packageJson.peerDependencies?.vite).toBe('>=5.0.0');
    expect(packageJson.devDependencies?.vite).toBe('>=5.0.0');
  });
});
