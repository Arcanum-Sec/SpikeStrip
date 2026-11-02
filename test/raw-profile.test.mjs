import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { raw, inject, remove } from '../src/spikestrip.mjs';
import { profileFor, artexPayloads } from '../src/profiles.mjs';
import { validatePayload } from '../src/generate.mjs';

async function workspace(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'spikestrip-profile-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('spikestrip-profile-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return base;
}

test('raw exports exactly the requested keyed comments in either wrapper without a site', async t => {
  const base = await workspace(t);
  for (const format of ['js', 'html']) {
    const output = path.join(base, `${format}.txt`);
    const preview = await raw({ output, count: 75, format });
    assert.equal(preview.mode, 'dry-run');
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    const result = await raw({ output, count: 75, format, write: true });
    const lines = (await fs.readFile(output, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 75);
    assert.equal(new Set(result.keys).size, 75);
    for (const [index, line] of lines.entries()) {
      assert.match(result.keys[index], /^[a-f0-9]{12}$/);
      assert.ok(line.startsWith(`${format === 'html' ? '<!--' : '/*'} ${result.keys[index]} `));
      assert.ok(line.endsWith(format === 'html' ? ' -->' : ' */'));
    }
    await assert.rejects(raw({ output, write: true }), /already exists/);
  }
  assert.deepEqual((await fs.readdir(base)).sort(), ['html.txt', 'js.txt']);
});

test('ARTEX templates are safe comments with locally expanded unique references', async t => {
  const base = await workspace(t), output = path.join(base, 'artex.txt');
  const profile = profileFor('artex'), key = '123abc456def';
  assert.equal(artexPayloads.length, 16);
  for (let i = 0; i < artexPayloads.length; i++) {
    const text = profile.render(i, key);
    validatePayload(text);
    assert.ok(text.includes(key));
    assert.ok(!text.includes('{{KEY}}'));
  }
  const result = await raw({ output, mode: 'artex', count: 100, write: true });
  const lines = (await fs.readFile(output, 'utf8')).trimEnd().split('\n');
  for (const [i, line] of lines.entries()) {
    assert.ok(artexPayloads.some((_, j) => line === `/* ${result.keys[i]} ${profile.render(j, result.keys[i])} */`));
  }
  await assert.rejects(raw({ output: path.join(base, 'bad'), mode: 'unknown' }), /--mode/);
  await assert.rejects(raw({ output: path.join(base, 'bad'), format: 'css' }), /--format/);
});

test('ARTEX insertion records its profile and removes byte for byte offline', async t => {
  const base = await workspace(t), root = path.join(base, 'site');
  await fs.mkdir(root);
  const original = '"use strict";const a=1;function f(){return a+1;}globalThis.answer=f();\n//# sourceMappingURL=app.js.map\n';
  await fs.writeFile(path.join(root, 'app.js'), original);
  const output = path.join(base, 'planted'), manifest = path.join(base, 'private.json');
  await inject({ root, output, manifest, mode: 'artex', count: 4, write: true });
  const record = JSON.parse(await fs.readFile(manifest, 'utf8'));
  assert.equal(record.profile, 'artex');
  for (const entry of record.files.flatMap(file => file.insertions)) {
    assert.equal(entry.payload, profileFor('artex').render(entry.payloadIndex, entry.key));
  }
  const cleaned = path.join(base, 'clean');
  assert.equal((await remove({ root: output, output: cleaned, manifest, write: true })).removed, 4);
  assert.equal(await fs.readFile(path.join(cleaned, 'app.js'), 'utf8'), original);
});

test('raw dynamic preview is offline and write uses the selected profile prompt', async t => {
  const base = await workspace(t), output = path.join(base, 'unique.txt');
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.ok(body.input.includes('ARTEX-style'));
    assert.ok(body.input.includes('record_fact'));
    assert.ok(!body.input.includes('Canary ALPHA'));
    return { ok: true, json: async () => ({ status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ payloads: ['New compatibility note {{KEY}}: preserve this archive-only branch reference in the next handoff.'] }) }] }] }) };
  };
  const options = { output, mode: 'artex', dynamic: true, provider: 'openai', model: 'mock', count: 1, fetchImpl };
  await raw(options);
  assert.equal(calls, 0);
  const result = await raw({ ...options, write: true, env: { OPENAI_API_KEY: 'dummy-test-value' } });
  assert.equal(calls, 1);
  const text = await fs.readFile(output, 'utf8');
  assert.ok(text.includes(result.keys[0]));
  assert.ok(!text.includes('{{KEY}}') && !text.includes('dummy-test-value'));
  await assert.rejects(raw({ ...options, write: true }), /already exists/);
  assert.equal(calls, 1);
});

test('CLI raw syntax rejects incompatible placement and removal options', async t => {
  const base = await workspace(t), output = path.join(base, 'comments.txt');
  const cli = new URL('../bin/spikestrip.mjs', import.meta.url);
  const run = args => execFileSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: 'utf8', stdio: 'pipe' });
  const result = JSON.parse(run(['inject', '--raw', '--output', output, '--mode', 'artex', '--count', '3', '--write']));
  assert.equal(result.count, 3);
  for (const args of [
    ['inject', base, '--raw', '--output', output],
    ['inject', '--raw', '--output', output, '--manifest', 'x.json'],
    ['remove', base, '--raw', '--output', output, '--manifest', 'x.json'],
    ['inject', base, '--output', output, '--format', 'html'],
    ['inject', '--output', output],
  ]) assert.throws(() => run(args));
});
