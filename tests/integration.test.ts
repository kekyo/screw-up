import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { build } from 'vite';
import dayjs from 'dayjs';
import { simpleGit } from 'simple-git';
import { findWorkspaceRoot, mergePackageMetadata, resolvePackageMetadata } from '../src/internal.js';
import { screwUp, generateBanner } from '../src/vite-plugin.js';

describe('screwUp plugin integration tests', () => {
  const tempBaseDir = join(tmpdir(), 'screw-up', 'integration-test', dayjs().format('YYYYMMDD_HHmmssSSS'));
  
  let tempDir: string;

  beforeEach(fn => {
    tempDir = join(tempBaseDir, fn.task.name);
    mkdirSync(tempDir, { recursive: true });
  });

  it('should generate correct banner from package metadata', () => {
    const metadata = {
      name: 'test-package',
      version: '1.0.0',
      description: 'A test package',
      author: 'Test Author <test@example.com>',
      license: 'MIT'
    };

    const outputKeys = ['name', 'version', 'description', 'author', 'license'];
    const banner = generateBanner(metadata, outputKeys);
    const expectedBanner = `/*!
 * name: test-package
 * version: 1.0.0
 * description: A test package
 * author: Test Author <test@example.com>
 * license: MIT
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should handle author as object', () => {
    const metadata = {
      name: 'test-package',
      version: '1.0.0', 
      'author.name': 'Test Author',
      'author.email': 'test@example.com'
    };

    const outputKeys = ['name', 'version', 'author.name', 'author.email'];
    const banner = generateBanner(metadata, outputKeys);
    const expectedBanner = `/*!
 * name: test-package
 * version: 1.0.0
 * author.name: Test Author
 * author.email: test@example.com
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should handle missing metadata gracefully', () => {
    const metadata = {};
    const outputKeys = ['name', 'version', 'description'];
    const banner = generateBanner(metadata, outputKeys);
    const expectedBanner = '';
    expect(banner).toBe(expectedBanner);
  })

  it('should build with banner inserted', async () => {
    // Create test package.json
    const packageJson = {
      name: 'test-lib',
      version: '2.0.0',
      description: 'Integration test library',
      author: 'Integration Tester',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create test source file
    const srcDir = join(tempDir, 'src')
    mkdirSync(srcDir)
    writeFileSync(join(srcDir, 'index.ts'), `
export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`)

    // Create test tsconfig.json
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        declaration: true,
        outDir: './dist'
      },
      include: ['src']
    };
    writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

    // Build with Vite
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp()],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'TestLib',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if banner is inserted - Vite outputs .mjs for ES modules
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    const expectedBanner = `/*!
 * name: test-lib
 * version: 2.0.0
 * description: Integration test library
 * author: Integration Tester
 * license: Apache-2.0
 */`;
    expect(output).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }, 30000); // 30 second timeout for build

  it('should use default output keys when not specified', () => {
    const metadata = {
      name: 'test-package',
      version: '1.0.0',
      description: 'A test package',
      author: 'Test Author',
      license: 'MIT',
      'repository.url': 'https://github.com/test/test-package'
    };

    const defaultOutputKeys = ['name', 'version', 'description', 'author', 'license', 'repository.url'];
    const banner = generateBanner(metadata, defaultOutputKeys);
    const expectedBanner = `/*!
 * name: test-package
 * version: 1.0.0
 * description: A test package
 * author: Test Author
 * license: MIT
 * repository.url: https://github.com/test/test-package
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should use custom output keys', async () => {
    const packageJson = {
      name: 'custom-lib',
      version: '1.0.0',
      description: 'Custom library',
      author: 'Custom Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "1.0.0"');

    const customOutputKeys = ['name', 'version', 'license'];
    
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ outputKeys: customOutputKeys })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'CustomLib',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    const outputPath = join(distDir, 'index.mjs');
    const output = readFileSync(outputPath, 'utf-8');
    const expectedBanner = `/*!
 * name: custom-lib
 * version: 1.0.0
 * license: MIT
 */`;
    expect(output).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }, 30000);

  it('should add banner to .d.ts files using default assetFilters', async () => {
    const packageJson = {
      name: 'test-lib',
      version: '1.0.0',
      description: 'Test library with TypeScript declarations',
      author: 'Test Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), `
export interface TestInterface {
  name: string;
  version: number;
}

export function createTest(name: string): TestInterface {
  return { name, version: 1 };
}
`);

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [
        {
          name: 'dts-generator',
          generateBundle() {
            // Simulate .d.ts file generation
            this.emitFile({
              type: 'asset',
              fileName: 'index.d.ts',
              source: `export interface TestInterface {
  name: string;
  version: number;
}

export declare function createTest(name: string): TestInterface;
`
            });
          }
        },
        screwUp() // Uses default assetFilters: ['\\.d\\.ts$'] - put after dts-generator
      ],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'TestLib',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if banner is added to .d.ts file
    const dtsPath = join(distDir, 'index.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    const expectedBanner = `/*!
 * name: test-lib
 * version: 1.0.0
 * description: Test library with TypeScript declarations
 * author: Test Author
 * license: MIT
 */`;
    expect(dtsContent).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(dtsContent).toContain('export interface TestInterface');
  }, 30000);

  it('should add banner to custom asset files using custom assetFilters', async () => {
    const packageJson = {
      name: 'custom-assets-lib',
      version: '2.0.0',
      description: 'Library with custom asset filters',
      author: 'Custom Author',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "2.0.0"');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [
        {
          name: 'custom-assets-generator',
          generateBundle() {
            // Emit .d.ts file
            this.emitFile({
              type: 'asset',
              fileName: 'types.d.ts',
              source: 'export declare const version: string;\n'
            });
            // Emit .json file
            this.emitFile({
              type: 'asset',
              fileName: 'metadata.json',
              source: JSON.stringify({ name: 'custom-assets-lib', version: '2.0.0' }, null, 2)
            });
            // Emit .txt file (should not get banner)
            this.emitFile({
              type: 'asset',
              fileName: 'readme.txt',
              source: 'This is a text file.\n'
            });
          }
        },
        screwUp({ assetFilters: ['\\.d\\.ts$', '\\.json$'] }) // Custom filters for .d.ts and .json - put after asset generator
      ],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'CustomAssetsLib',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    const expectedBanner = `/*!
 * name: custom-assets-lib
 * version: 2.0.0
 * description: Library with custom asset filters
 * author: Custom Author
 * license: Apache-2.0
 */`;

    // Check .d.ts file has banner
    const dtsPath = join(distDir, 'types.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    expect(dtsContent).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // Check .json file has banner
    const jsonPath = join(distDir, 'metadata.json');
    expect(existsSync(jsonPath)).toBe(true);
    const jsonContent = readFileSync(jsonPath, 'utf-8');
    expect(jsonContent).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    // Check .txt file does NOT have banner
    const txtPath = join(distDir, 'readme.txt');
    expect(existsSync(txtPath)).toBe(true);
    const txtContent = readFileSync(txtPath, 'utf-8');
    expect(txtContent).not.toContain('name: custom-assets-lib');
    expect(txtContent).toBe('This is a text file.\n');
  }, 30000);

  it('should not insert banner when insertMetadataBanner is false', async () => {
    // Create test package.json
    const packageJson = {
      name: 'no-banner-test',
      version: '1.0.0',
      description: 'Test with banner insertion disabled',
      author: 'Test Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create test source file
    const srcDir = join(tempDir, 'src')
    mkdirSync(srcDir)
    writeFileSync(join(srcDir, 'index.ts'), `
export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`)

    // Build with banner insertion disabled
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ insertMetadataBanner: false })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoBannerTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that banner is NOT inserted
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).not.toContain('name: no-banner-test');
    expect(output).not.toContain('version: 1.0.0');
    expect(output).not.toContain('/*!');
    expect(output).toContain('function hello'); // Verify the actual code is still there
  }, 30000);

  it('should not insert banner to asset files when insertMetadataBanner is false', async () => {
    const packageJson = {
      name: 'no-asset-banner-test',
      version: '2.0.0',
      description: 'Test asset banner insertion disabled',
      author: 'Test Author',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), `
export interface TestInterface {
  name: string;
  version: number;
}

export function createTest(name: string): TestInterface {
  return { name, version: 1 };
}
`);

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [
        {
          name: 'dts-generator',
          generateBundle() {
            // Simulate .d.ts file generation
            this.emitFile({
              type: 'asset',
              fileName: 'index.d.ts',
              source: `export interface TestInterface {
  name: string;
  version: number;
}

export declare function createTest(name: string): TestInterface;
`
            });
          }
        },
        screwUp({ insertMetadataBanner: false }) // Banner insertion disabled
      ],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoAssetBannerTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that banner is NOT added to .d.ts file
    const dtsPath = join(distDir, 'index.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    expect(dtsContent).not.toContain('name: no-asset-banner-test');
    expect(dtsContent).not.toContain('/*!');
    expect(dtsContent).toContain('export interface TestInterface'); // Verify the actual content is still there
  }, 30000);

  it('should not process files in writeBundle when insertMetadataBanner is false', async () => {
    const packageJson = {
      name: 'no-writebundle-banner-test',
      version: '1.5.0',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const name = "test"');

    const distDir = join(tempDir, 'dist');
    
    // Build first to create the dist directory
    await build({
      root: tempDir,
      plugins: [screwUp({ insertMetadataBanner: false, assetFilters: ['\\.d\\.ts$'] })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoWriteBundleBannerTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });
    
    // Create files that simulate what other plugins would generate after the build
    const externalDtsPath = join(distDir, 'external.d.ts');
    writeFileSync(externalDtsPath, 'export declare const external: string;');

    // Second build to trigger writeBundle which processes existing files
    await build({
      root: tempDir,
      plugins: [screwUp({ insertMetadataBanner: false, assetFilters: ['\\.d\\.ts$'] })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoWriteBundleBannerTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false,
        emptyOutDir: false // Don't empty the dist directory
      }
    });

    // Check that banner was NOT added to external file
    const externalContent = readFileSync(externalDtsPath, 'utf-8');
    expect(externalContent).not.toContain('name: no-writebundle-banner-test');
    expect(externalContent).not.toContain('/*!');
    expect(externalContent).toBe('export declare const external: string;'); // Content should be unchanged
  }, 30000);
});

describe('workspace functionality tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'screw-up-workspace-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should find workspace root with workspaces field', async () => {
    // Create workspace root package.json
    const rootPackageJson = {
      name: 'my-workspace',
      version: '1.0.0',
      workspaces: ['packages/*']
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

    // Create child package
    const packagesDir = join(tempDir, 'packages', 'child');
    mkdirSync(packagesDir, { recursive: true });
    
    const workspaceRoot = await findWorkspaceRoot(packagesDir);
    expect(workspaceRoot).toBe(tempDir);
  });

  it('should find workspace root with pnpm-workspace.yaml', async () => {
    // Create workspace files
    const rootPackageJson = { name: 'my-workspace', version: '1.0.0' };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(rootPackageJson, null, 2));
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"');

    const packagesDir = join(tempDir, 'packages', 'child');
    mkdirSync(packagesDir, { recursive: true });
    
    const workspaceRoot = await findWorkspaceRoot(packagesDir);
    expect(workspaceRoot).toBe(tempDir);
  });

  it('should find workspace root with lerna.json', async () => {
    // Create workspace files
    const rootPackageJson = { name: 'my-workspace', version: '1.0.0' };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(rootPackageJson, null, 2));
    writeFileSync(join(tempDir, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }, null, 2));

    const packagesDir = join(tempDir, 'packages', 'child');
    mkdirSync(packagesDir, { recursive: true });
    
    const workspaceRoot = await findWorkspaceRoot(packagesDir);
    expect(workspaceRoot).toBe(tempDir);
  });

  it('should return undefined when no workspace found', async () => {
    const nonWorkspaceDir = join(tempDir, 'not-a-workspace');
    mkdirSync(nonWorkspaceDir, { recursive: true });
    
    const workspaceRoot = await findWorkspaceRoot(nonWorkspaceDir);
    expect(workspaceRoot).toBe(undefined);
  });

  it('should merge package metadata correctly', async () => {
    const parentMetadata = {
      name: 'parent',
      version: '1.0.0',
      author: 'Parent Author',
      license: 'MIT'
    };

    const childMetadata = {
      name: 'child',
      description: 'Child package'
    };

    const sourceMaps = new Map<string, string>();
    const merged = await mergePackageMetadata(
      true, true, sourceMaps, parentMetadata, childMetadata, tempDir, tempDir, tempDir);

    expect(merged.name).toBe('child'); // Child overrides
    expect(merged.version).toBe('1.0.0'); // Inherited from parent
    expect(merged.author).toBe('Parent Author'); // Inherited from parent
    expect(merged.license).toBe('MIT'); // Inherited from parent
    expect(merged.description).toBe('Child package'); // From child
  });

  it('should resolve metadata for non-workspace project', async () => {
    // Create standalone package
    const packageJson = {
      name: 'standalone',
      version: '2.0.0',
      author: 'Standalone Author'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const { metadata } = await resolvePackageMetadata(tempDir, true, true);
    expect(metadata.name).toBe('standalone');
    expect(metadata.version).toBe('2.0.0');
    expect(metadata.author).toBe('Standalone Author');
  });

  it('should resolve metadata for workspace child with inheritance', async () => {
    // Create workspace root
    const rootPackageJson = {
      name: 'workspace-root',
      version: '1.0.0',
      author: 'Workspace Author',
      license: 'Apache-2.0',
      workspaces: ['packages/*']
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

    // Create child package
    const childDir = join(tempDir, 'packages', 'child');
    mkdirSync(childDir, { recursive: true });
    const childPackageJson = {
      name: 'child-package',
      description: 'A child package'
    };
    writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));

    const { metadata } = await resolvePackageMetadata(childDir, true, true);
    expect(metadata.name).toBe('child-package'); // From child
    expect(metadata.version).toBe('1.0.0'); // Inherited from root
    expect(metadata.author).toBe('Workspace Author'); // Inherited from root
    expect(metadata.license).toBe('Apache-2.0'); // Inherited from root
    expect(metadata.description).toBe('A child package'); // From child
  });

  it('should build workspace child with inherited metadata', async () => {
    // Create workspace root
    const rootPackageJson = {
      name: 'my-monorepo',
      version: '3.0.0',
      author: 'Monorepo Author',
      license: 'MIT',
      workspaces: ['packages/*']
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(rootPackageJson, null, 2));

    // Create child package
    const childDir = join(tempDir, 'packages', 'ui-lib');
    mkdirSync(childDir, { recursive: true });
    const childPackageJson = {
      name: '@my-monorepo/ui-lib',
      description: 'UI component library'
    };
    writeFileSync(join(childDir, 'package.json'), JSON.stringify(childPackageJson, null, 2));

    // Create source file
    const srcDir = join(childDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), `
export function Button() {
  return 'UI Button';
}
`);

    // Build with Vite from child directory
    const distDir = join(childDir, 'dist');
    await build({
      root: childDir,
      plugins: [screwUp()],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'UILib',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if banner includes inherited metadata
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('@my-monorepo/ui-lib'); // Child name
    expect(output).toContain('3.0.0'); // Inherited version
    expect(output).toContain('Monorepo Author'); // Inherited author
    expect(output).toContain('MIT'); // Inherited license
    expect(output).toContain('UI component library'); // Child description
  }, 30000);
});

describe('shebang banner insertion tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'screw-up-shebang-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should insert banner after shebang in generated files', async () => {
    const packageJson = {
      name: 'shebang-test',
      version: '1.0.0',
      description: 'Test shebang banner insertion',
      author: 'Test Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), `
export function createScript(): string {
  return '#!/usr/bin/env node\\nconsole.log("Hello");';
}
`);

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [
        {
          name: 'shebang-file-generator',
          generateBundle() {
            // Generate a file with shebang
            this.emitFile({
              type: 'asset',
              fileName: 'cli.js',
              source: '#!/usr/bin/env node\nconsole.log("CLI script");'
            });
            // Generate a .d.ts file with shebang (unusual but possible)
            this.emitFile({
              type: 'asset',
              fileName: 'cli.d.ts',
              source: '#!/usr/bin/env node\nexport declare function cli(): void;'
            });
          }
        },
        screwUp({ assetFilters: ['\\.js$', '\\.d\\.ts$'] })
      ],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'ShebangTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check CLI script - banner should be after shebang
    const cliPath = join(distDir, 'cli.js');
    expect(existsSync(cliPath)).toBe(true);
    const cliContent = readFileSync(cliPath, 'utf-8');
    expect(cliContent).toMatch(/^#!/);
    expect(cliContent).toMatch(/#!/);
    expect(cliContent).toContain('name: shebang-test');
    // Verify shebang comes first, then banner
    const lines = cliContent.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env node');
    expect(lines[1]).toBe('/*!');

    // Check .d.ts file - banner should be after shebang
    const dtsPath = join(distDir, 'cli.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    expect(dtsContent).toMatch(/^#!/);
    expect(dtsContent).toContain('name: shebang-test');
    const dtsLines = dtsContent.split('\n');
    expect(dtsLines[0]).toBe('#!/usr/bin/env node');
    expect(dtsLines[1]).toBe('/*!');
  }, 30000);

  it('should insert banner at beginning for files without shebang', async () => {
    const packageJson = {
      name: 'no-shebang-test',
      version: '2.0.0',
      author: 'Test Author'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "2.0.0"');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [
        {
          name: 'regular-file-generator',
          generateBundle() {
            this.emitFile({
              type: 'asset',
              fileName: 'regular.d.ts',
              source: 'export declare const version: string;'
            });
          }
        },
        screwUp()
      ],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoShebangTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that banner is at the beginning for files without shebang
    const dtsPath = join(distDir, 'regular.d.ts');
    expect(existsSync(dtsPath)).toBe(true);
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    expect(dtsContent).toMatch(/^\/\*!/);
    expect(dtsContent).toContain('name: no-shebang-test');
    const lines = dtsContent.split('\n');
    expect(lines[0]).toBe('/*!');
  }, 30000);

  it('should handle writeBundle with shebang files', async () => {
    const packageJson = {
      name: 'writebundle-shebang-test',
      version: '1.5.0',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const name = "test"');

    const distDir = join(tempDir, 'dist');
    
    // Build first to create the dist directory
    await build({
      root: tempDir,
      plugins: [screwUp({ assetFilters: ['\\.d\\.ts$'] })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'WriteBundleShebangTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });
    
    // Create files that simulate what other plugins would generate after the build
    const shebangDtsPath = join(distDir, 'generated.d.ts');
    writeFileSync(shebangDtsPath, '#!/usr/bin/env node\nexport declare const generated: string;');
    
    const regularDtsPath = join(distDir, 'normal.d.ts');
    writeFileSync(regularDtsPath, 'export declare const normal: string;');

    // Second build to trigger writeBundle which processes existing files
    await build({
      root: tempDir,
      plugins: [screwUp({ assetFilters: ['\\.d\\.ts$'] })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'WriteBundleShebangTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false,
        emptyOutDir: false // Don't empty the dist directory
      }
    });

    // Check shebang file - should have banner after shebang
    const shebangContent = readFileSync(shebangDtsPath, 'utf-8');
    expect(shebangContent).toMatch(/^#!/);
    expect(shebangContent).toContain('name: writebundle-shebang-test');
    const shebangLines = shebangContent.split('\n');
    expect(shebangLines[0]).toBe('#!/usr/bin/env node');
    expect(shebangLines[1]).toBe('/*!');

    // Check regular file - should have banner at beginning
    const regularContent = readFileSync(regularDtsPath, 'utf-8');
    expect(regularContent).toMatch(/^\/\*!/);
    expect(regularContent).toContain('name: writebundle-shebang-test');
  }, 30000);
});

describe('metadata file generation tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'screw-up-metadata-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should generate metadata TypeScript file with default path when enabled', async () => {
    const packageJson = {
      name: 'metadata-test',
      version: '1.0.0',
      description: 'Test metadata generation',
      author: 'Test Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const hello = "world";');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ outputMetadataFile: true })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'MetadataTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if metadata file was generated
    const metadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    expect(existsSync(metadataPath)).toBe(true);
    
    const metadataContent = readFileSync(metadataPath, 'utf-8');
    expect(metadataContent).toContain('// This file is auto-generated by screw-up plugin');
    expect(metadataContent).toContain('export const name = "metadata-test";');
    expect(metadataContent).toContain('export const version = "1.0.0";');
    expect(metadataContent).toContain('export const description = "Test metadata generation";');
    expect(metadataContent).toContain('export const author = "Test Author";');
    expect(metadataContent).toContain('export const license = "MIT";');
  }, 30000);

  it('should generate metadata TypeScript file with custom path', async () => {
    const packageJson = {
      name: 'custom-metadata-test',
      version: '2.0.0',
      description: 'Custom path test',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "2.0.0";');

    const customMetadataPath = 'lib/metadata.ts';
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ 
        outputMetadataFile: true,
        outputMetadataFilePath: customMetadataPath 
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'CustomMetadataTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if metadata file was generated at custom path
    const metadataPath = join(tempDir, customMetadataPath);
    expect(existsSync(metadataPath)).toBe(true);
    
    const metadataContent = readFileSync(metadataPath, 'utf-8');
    expect(metadataContent).toContain('export const name = "custom-metadata-test";');
    expect(metadataContent).toContain('export const version = "2.0.0";');
    expect(metadataContent).toContain('export const description = "Custom path test";');
    expect(metadataContent).toContain('export const license = "Apache-2.0";');
  }, 30000);

  it('should sanitize keys with special characters', async () => {
    const packageJson = {
      name: 'sanitize-test',
      version: '1.0.0',
      'custom-key': 'custom-value',
      'repository.url': 'https://github.com/test/repo',
      '123invalid': 'should-be-prefixed'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const test = true;');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ 
        outputMetadataFile: true,
        outputMetadataKeys: ['name', 'version', 'custom-key', 'repository.url', '123invalid']
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'SanitizeTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    const metadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    const metadataContent = readFileSync(metadataPath, 'utf-8');
    
    expect(metadataContent).toContain('export const name = "sanitize-test";');
    expect(metadataContent).toContain('export const version = "1.0.0";');
    expect(metadataContent).toContain('export const custom_key = "custom-value";');
    expect(metadataContent).toContain('export const repository_url = "https://github.com/test/repo";');
    expect(metadataContent).toContain('export const _123invalid = "should-be-prefixed";');
  }, 30000);

  it('should disable metadata generation when outputMetadataFile is false', async () => {
    const packageJson = {
      name: 'no-metadata-test',
      version: '1.0.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const test = true;');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ outputMetadataFile: false })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'NoMetadataTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that no metadata file was generated
    const defaultMetadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    expect(existsSync(defaultMetadataPath)).toBe(false);
  }, 30000);

  it('should use custom outputMetadataKeys different from outputKeys', async () => {
    const packageJson = {
      name: 'custom-keys-test',
      version: '1.0.0',
      description: 'Test custom metadata keys',
      author: 'Test Author',
      license: 'MIT',
      repository: { url: 'https://github.com/test/repo' }
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const test = true;');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ 
        outputKeys: ['name', 'version'], // Banner only has name and version
        outputMetadataFile: true,
        outputMetadataKeys: ['name', 'version', 'description', 'license'] // Metadata has more fields
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'CustomKeysTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check banner only has name and version
    const outputPath = join(distDir, 'index.mjs');
    const outputContent = readFileSync(outputPath, 'utf-8');
    expect(outputContent).toContain('name: custom-keys-test');
    expect(outputContent).toContain('version: 1.0.0');
    expect(outputContent).not.toContain('description: Test custom metadata keys');
    expect(outputContent).not.toContain('license: MIT');

    // Check metadata file has name, version, description, and license
    const metadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    const metadataContent = readFileSync(metadataPath, 'utf-8');
    expect(metadataContent).toContain('export const name = "custom-keys-test";');
    expect(metadataContent).toContain('export const version = "1.0.0";');
    expect(metadataContent).toContain('export const description = "Test custom metadata keys";');
    expect(metadataContent).toContain('export const license = "MIT";');
    expect(metadataContent).not.toContain('repository'); // Not in outputMetadataKeys
  }, 30000);

  it('should not generate metadata file by default when outputMetadataFile is not specified', async () => {
    const packageJson = {
      name: 'default-disabled-test',
      version: '1.0.0',
      description: 'Test default disabled behavior',
      author: 'Test Author'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const test = true;');

    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ 
        outputKeys: ['name', 'version', 'author'] // Only specify outputKeys
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'DefaultDisabledTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Banner should be generated
    const outputPath = join(distDir, 'index.mjs');
    const outputContent = readFileSync(outputPath, 'utf-8');
    expect(outputContent).toContain('name: default-disabled-test');
    expect(outputContent).toContain('version: 1.0.0');
    expect(outputContent).toContain('author: Test Author');

    // But no metadata file should be generated since outputMetadataFile defaults to false
    const metadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    expect(existsSync(metadataPath)).toBe(false);
  }, 30000);
});

describe('git metadata integration tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'screw-up-git-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should insert git metadata in banner', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json without version
    const packageJson = {
      name: 'git-metadata-test',
      description: 'Test git metadata insertion',
      author: 'Test Author',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const hello = "world";');

    // Initial commit and tag
    await git.add('.');
    const commitResult = await git.commit('Initial commit');
    const commitHash = commitResult.commit;
    await git.tag(['v1.2.3']);

    // Build with git metadata enabled
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({
        outputKeys: ['name', 'version', 'author', 'git.commit.hash', 'git.commit.shortHash', 'git.commit.date', 'git.commit.message']
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'GitMetadataTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if git metadata is inserted in banner
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('name: git-metadata-test');
    expect(output).toContain('version: 1.2.3'); // From git tag
    expect(output).toContain('author: Test Author');
    expect(output).toContain(`git.commit.hash: ${commitHash}`);
    expect(output).toContain(`git.commit.shortHash: ${commitHash.substring(0, 7)}`);
    expect(output).toContain('git.commit.date:'); // Date should be present
    expect(output).toContain('git.commit.message: Initial commit');
  }, 30000);

  it('should use git tag version when package.json has no version', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json WITHOUT version field
    const packageJson = {
      name: 'git-version-test',
      description: 'Test git version fallback',
      author: 'Test Author',
      license: 'Apache-2.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "from-git";');

    // Initial commit and tag with semantic version
    await git.add('.');
    await git.commit('Initial commit');
    await git.tag(['v2.1.0']);

    // Build with default settings
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp()], // Uses default outputKeys including 'version'
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'GitVersionTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if git tag version is used in banner
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('name: git-version-test');
    expect(output).toContain('version: 2.1.0'); // Should come from git tag, not package.json
    expect(output).toContain('description: Test git version fallback');
  }, 30000);

  it('should increment version for dirty working directory', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');  
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json
    const packageJson = {
      name: 'dirty-repo-test',
      description: 'Test dirty working directory version increment',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const initial = true;');

    // Initial commit and tag
    await git.add('.');
    await git.commit('Initial commit');
    await git.tag(['v1.0.0']);

    // Make working directory dirty by adding untracked file
    writeFileSync(join(srcDir, 'newfile.ts'), 'export const added = true;');

    // Build with working directory check enabled (default)
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({
        outputKeys: ['name', 'version', 'description'],
        checkWorkingDirectoryStatus: true
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'DirtyRepoTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if version was incremented due to dirty working directory
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('name: dirty-repo-test');
    expect(output).toContain('version: 1.0.1'); // Should be incremented from 1.0.0
    expect(output).toContain('description: Test dirty working directory version increment');
  }, 30000);

  it('should respect .gitignore when checking working directory status', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json
    const packageJson = {
      name: 'gitignore-test',
      description: 'Test .gitignore handling in working directory check',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create .gitignore
    writeFileSync(join(tempDir, '.gitignore'), '*.tmp\nnode_modules/\n.cache/\n');

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const test = true;');

    // Initial commit and tag
    await git.add('.');
    await git.commit('Initial commit with .gitignore');
    await git.tag(['v2.0.0']);

    // Add ignored files (should not trigger version increment)
    writeFileSync(join(tempDir, 'temp.tmp'), 'temporary file');
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'package.json'), '{}');

    // Build with working directory check enabled
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({
        outputKeys: ['name', 'version'],
        checkWorkingDirectoryStatus: true
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'GitignoreTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that version was NOT incremented (ignored files don't count)
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('name: gitignore-test');
    expect(output).toContain('version: 2.0.0'); // Should NOT be incremented
  }, 30000);

  it('should generate metadata file with git information', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json
    const packageJson = {
      name: 'git-metadata-file-test',
      description: 'Test git metadata in generated file',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const app = "test";');

    // Initial commit and tag
    await git.add('.');
    const commitResult = await git.commit('Add metadata file test');
    const commitHash = commitResult.commit;
    await git.tag(['v3.1.0']);

    // Build with metadata file generation enabled
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({
        outputMetadataFile: true,
        outputMetadataKeys: ['name', 'version', 'git.commit.hash', 'git.commit.message']
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'GitMetadataFileTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check if metadata file contains git information
    const metadataPath = join(tempDir, 'src', 'generated', 'packageMetadata.ts');
    expect(existsSync(metadataPath)).toBe(true);
    
    const metadataContent = readFileSync(metadataPath, 'utf-8');
    expect(metadataContent).toContain('export const name = "git-metadata-file-test";');
    expect(metadataContent).toContain('export const version = "3.1.0";');
    expect(metadataContent).toContain(`export const git_commit_hash = "${commitHash}";`);
    expect(metadataContent).toContain('export const git_commit_message = "Add metadata file test";');
  }, 30000);

  it('should handle complex git history with branches and merges', async () => {
    // Initialize git repository
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create package.json
    const packageJson = {
      name: 'complex-git-test',
      description: 'Test complex git history',
      license: 'MIT'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create source file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "1.0.0";');

    // Initial commit and tag
    await git.add('.');
    await git.commit('Initial commit');
    await git.tag(['v1.0.0']);

    // Create feature branch with higher version tag
    await git.checkoutLocalBranch('feature');
    writeFileSync(join(srcDir, 'feature.ts'), 'export const feature = true;');
    await git.add('.');
    await git.commit('Add feature');
    await git.tag(['v2.0.0']); // Higher version on feature branch

    // Switch back to main and merge
    await git.checkout('main');
    await git.merge(['feature', '--no-ff', '-m', 'Merge feature branch']);

    // Build and verify highest version is used
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({
        outputKeys: ['name', 'version', 'git.commit.message']
      })],
      build: {
        lib: {
          entry: join(srcDir, 'index.ts'),
          name: 'ComplexGitTest',
          fileName: 'index',
          formats: ['es']
        },
        outDir: distDir,
        minify: false
      }
    });

    // Check that highest version from git history is used
    const outputPath = join(distDir, 'index.mjs');
    expect(existsSync(outputPath)).toBe(true);
    
    const output = readFileSync(outputPath, 'utf-8');
    expect(output).toContain('name: complex-git-test');
    expect(output).toContain('version: 2.0.1'); // Should be incremented from highest tag v2.0.0
    expect(output).toContain('git.commit.message: Merge feature branch');
  }, 30000);
});
