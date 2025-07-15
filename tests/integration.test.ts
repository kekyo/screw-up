import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { build } from 'vite';
import { screwUp } from '../src/index.js';
import { generateBanner, readPackageMetadata, findWorkspaceRoot, mergePackageMetadata, resolvePackageMetadata } from '../src/internal.js';

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
 * author: Test Author <test@example.com>
 * description: A test package
 * license: MIT
 * name: test-package
 * version: 1.0.0
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

    const banner = generateBanner(metadata);
    const expectedBanner = `/*!
 * author.email: test@example.com
 * author.name: Test Author
 * name: test-package
 * version: 1.0.0
 */`;
    expect(banner).toBe(expectedBanner);
  });

  it('should handle missing metadata gracefully', () => {
    const metadata = {};
    const banner = generateBanner(metadata);
    const expectedBanner = '';
    expect(banner).toBe(expectedBanner);
  })

  it('should read package metadata correctly', async () => {
    const packageJson = {
      name: 'test-package',
      version: '1.0.0',
      description: 'A test package',
      author: 'Test Author',
      license: 'MIT'
    };

    const packagePath = join(tempDir, 'package.json');
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    const metadata = await readPackageMetadata(packagePath);
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
 * author: Integration Tester
 * description: Integration test library
 * license: Apache-2.0
 * name: test-lib
 * version: 2.0.0
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

  it('should return null when no workspace found', async () => {
    const nonWorkspaceDir = join(tempDir, 'not-a-workspace');
    mkdirSync(nonWorkspaceDir, { recursive: true });
    
    const workspaceRoot = await findWorkspaceRoot(nonWorkspaceDir);
    expect(workspaceRoot).toBe(null);
  });


  it('should merge package metadata correctly', () => {
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

    const merged = mergePackageMetadata(parentMetadata, childMetadata);
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

    const metadata = await resolvePackageMetadata(tempDir);
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

    const metadata = await resolvePackageMetadata(childDir);
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
