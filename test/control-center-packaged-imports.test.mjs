import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('packaged account resources import without checkout dependencies', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'router-package-import-'));
  try {
    const resources = path.join(scratch, 'Resources');
    mkdirSync(resources);
    const config = readFileSync(path.join(root, 'apps/control-center/electron-builder.yml'), 'utf8');
    const block = config.split('extraResources:\n')[1]?.split(/\n(?=\S)/)[0];
    assert.ok(block, 'extraResources block must exist');
    const mappings = [...block.matchAll(/^  - from: (.+)\n    to: (.+)$/gm)];
    assert.ok(mappings.length > 0, 'resource staging cannot be empty');
    assert.equal(mappings.length, (block.match(/^  - from:/gm) || []).length, 'every resource mapping must be understood');
    for (const [, from, to] of mappings) {
      const source = path.resolve(root, 'apps/control-center', from.trim());
      assert.ok(existsSync(source), `required packaged resource source is missing: ${from}`);
      const destination = path.resolve(resources, to.trim());
      assert.ok(destination.startsWith(resources + path.sep));
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
    const probe = [
      'spawnable-command.mjs', 'chatgpt-login-lease.mjs', 'file-security.mjs',
      'path-security.mjs', 'process-identity.mjs', 'chatgpt-account-operation-lock.mjs',
      'chatgpt-request-use-lease.mjs', 'paths.mjs', 'tray-install.mjs',
      'chatgpt-account-pool.mjs', 'codex-binary.mjs', 'codex-shim.mjs',
      'discovery-mode.mjs', 'chatgpt-profile-switch.mjs',
    ].map(name =>
      `await import(${JSON.stringify(pathToFileURL(path.join(resources, 'src', name)).href)});`
    ).join('\n') + '\nconsole.log("PACKAGED_ACCOUNT_IMPORTS_OK");';
    const environment = { PATH: process.env.PATH, HOME: scratch, CODEX_HOME: path.join(scratch, 'codex') };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PACKAGED_ACCOUNT_IMPORTS_OK/);
    const dependency = path.join(resources, 'node_modules/proper-lockfile');
    assert.ok(existsSync(dependency));
    rmSync(dependency, { recursive: true });
    const missingDependency = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(missingDependency.status, 0);
    assert.match(missingDependency.stderr, /proper-lockfile/);
    assert.equal(missingDependency.signal, null, 'negative control must fail normally, not time out');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
