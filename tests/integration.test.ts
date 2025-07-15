import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { build } from 'vite';
import { screwUp, generateBanner, readPackageMetadata } from '../src/index';

describe('screwUp plugin integration tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'screw-up-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      //console.info(tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should generate correct banner from package metadata', () => {
    const metadata = {
      name: 'test-package',
      version: '1.0.0',
      description: 'A test package',
      author: 'Test Author <test@example.com>',
      license: 'MIT'
    };

    const banner = generateBanner(metadata);
    const expectedBanner = `/*!
 * test-package 1.0.0
 * A test package
 * Author: Test Author <test@example.com>
 * License: MIT
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should handle author as object', () => {
    const metadata = {
      name: 'test-package',
      version: '1.0.0', 
      author: { name: 'Test Author', email: 'test@example.com' }
    };

    const banner = generateBanner(metadata);
    const expectedBanner = `/*!
 * test-package 1.0.0
 * Author: Test Author <test@example.com>
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should handle missing metadata gracefully', () => {
    const metadata = {};
    const banner = generateBanner(metadata);
    const expectedBanner = `/*!
 * Unknown Package 0.0.0
 */`;
    expect(banner).toBe(expectedBanner);
  })

  it('should read package metadata correctly', () => {
    const packageJson = {
      name: 'test-package',
      version: '1.0.0',
      description: 'A test package',
      author: 'Test Author',
      license: 'MIT'
    };

    const packagePath = join(tempDir, 'package.json');
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    const metadata = readPackageMetadata(packagePath);
    expect(metadata.name).toBe('test-package');
    expect(metadata.version).toBe('1.0.0');
    expect(metadata.description).toBe('A test package');
    expect(metadata.author).toBe('Test Author');
    expect(metadata.license).toBe('MIT');
  });

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
 * test-lib 2.0.0
 * Integration test library
 * Author: Integration Tester
 * License: Apache-2.0
 */`;
    expect(output).toMatch(new RegExp(`^${expectedBanner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }, 30000); // 30 second timeout for build

  it('should use custom banner template', async () => {
    const packageJson = {
      name: 'custom-lib',
      version: '1.0.0'
    };
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.ts'), 'export const version = "1.0.0"');

    const customTemplate = '/* Custom Banner: custom-lib */';
    
    const distDir = join(tempDir, 'dist');
    await build({
      root: tempDir,
      plugins: [screwUp({ bannerTemplate: customTemplate })],
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
    expect(output.startsWith(customTemplate)).toBe(true);
  }, 30000);
});
