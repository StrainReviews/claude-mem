#!/usr/bin/env node

const { execSync } = require('child_process');
const { existsSync, readFileSync, cpSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
const IS_WINDOWS = process.platform === 'win32';

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getGitignorePatterns(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  const lines = readFileSync(gitignorePath, 'utf-8').split('\n');
  return lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
}

function toRsyncExcludes(patterns) {
  return patterns.map(pattern => `--exclude=${JSON.stringify(pattern)}`).join(' ');
}

// Windows-Fix (fork-local): rsync is not available on Windows (nor in Git Bash
// on a default install), so `sync-marketplace` aborted before it copied
// anything or restarted the worker. On win32 we mirror the copy with a native
// fs.cpSync + gitignore-style filter instead. Deliberately copy-only (no
// rsync --delete): leaving a few stale files in the dest is harmless, whereas
// hand-rolled pruning against a live plugin cache is risky. The rsync path is
// preserved unchanged for Linux/macOS.
function isExcludedRel(rel, patterns) {
  if (!rel) return false;
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  for (let pattern of patterns) {
    let p = pattern.replace(/\/+$/, '');       // trailing slash
    if (p.startsWith('**/')) p = p.slice(3);    // `**/foo` -> name match on foo
    if (!p) continue;
    if (p.startsWith('*.')) {                    // `*.log` -> suffix match
      if (base.endsWith(p.slice(1))) return true;
      continue;
    }
    if (p.includes('/')) {                       // `a/b` -> path prefix match
      if (rel === p || rel.startsWith(p + '/')) return true;
      continue;
    }
    if (segs.includes(p)) return true;           // `node_modules` -> any segment
  }
  return false;
}

function syncDir(srcRoot, destRoot, hardExcludes, gitignoreBase) {
  const patterns = [...hardExcludes, ...getGitignorePatterns(gitignoreBase)];
  if (IS_WINDOWS) {
    cpSync(srcRoot, destRoot, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(srcRoot, src).split(path.sep).join('/');
        return !isExcludedRel(rel, patterns);
      }
    });
  } else {
    const excludes = toRsyncExcludes(patterns);
    execSync(
      `rsync -av --delete ${excludes} ${JSON.stringify(srcRoot + '/')} ${JSON.stringify(destRoot + '/')}`,
      { stdio: 'inherit' }
    );
  }
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running sync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use the claude-mem UI on the configured worker port to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force sync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

console.log('Syncing to marketplace...');
try {
  const rootDir = path.join(__dirname, '..');

  syncDir(
    rootDir,
    INSTALLED_PATH,
    ['.git', 'bun.lock', 'package-lock.json', 'scripts/package.json', 'scripts/node_modules'],
    rootDir
  );

  console.log('Running bun install in marketplace...');
  execSync('bun install', { cwd: INSTALLED_PATH, stdio: 'inherit' });

  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);
  const pluginDir = path.join(rootDir, 'plugin');

  console.log(`Syncing to cache folder (version ${version})...`);
  syncDir(pluginDir, CACHE_VERSION_PATH, ['.git'], pluginDir);

  console.log(`Running bun install in cache folder (version ${version})...`);
  execSync('bun install', { cwd: CACHE_VERSION_PATH, stdio: 'inherit' });

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
