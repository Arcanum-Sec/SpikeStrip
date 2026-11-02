import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parse as parseJS } from 'acorn';
import { parse as parseHTML } from 'parse5';
import { profileFor } from './profiles.mjs';
import { generatePayloads, validateDynamic, validatePayload } from './generate.mjs';

const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv',
  '__pycache__', '.spikestrip', 'coverage']);
const extensions = new Set(['.html', '.htm', '.js', '.mjs', '.cjs']);
const unsupportedSourceExtensions = new Set(['.jsx', '.ts', '.tsx']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => {
  // Windows resolves ordinary paths without regard to letter case.
  if (process.platform === 'win32') {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  return child === parent || child.startsWith(parent + path.sep);
};
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function noSymlinks(file) {
  let cursor = path.parse(file).root;
  for (const part of file.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink path refused: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function pathsFor(root, output) {
  root = path.resolve(root); output = path.resolve(output);
  await noSymlinks(root); await noSymlinks(output);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Root must be a directory');
  if (inside(root, output) || inside(output, root)) throw new Error('Root and output must be separate, non-nested directories');
  if (await exists(output)) throw new Error('Output already exists; choose a new directory');
  return { root, output };
}

async function inventory(root) {
  const files = [], skipped = [];
  async function visit(directory, prefix = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix + entry.name, absolute = path.join(directory, entry.name);
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        skipped.push({ file: relative, reason: 'environment file' }); continue;
      }
      if (entry.isSymbolicLink()) { skipped.push({ file: relative, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await visit(absolute, relative + '/');
      } else if (entry.isFile()) files.push(relative);
    }
  }
  await visit(root);
  return { files, skipped };
}

function normalizedJS(source, mode) {
  const tree = parseJS(source, { ecmaVersion: 'latest', sourceType: mode,
    allowHashBang: true });
  return { tree, signature: JSON.stringify(tree, (key, value) => {
    if (['start', 'end', 'loc', 'range'].includes(key)) return undefined;
    if (typeof value === 'bigint') return `${value}n`;
    return value;
  }) };
}

function inspectJS(source, extension) {
  const modes = extension === '.mjs' ? ['module'] : extension === '.cjs'
    ? ['commonjs'] : ['script', 'module', 'commonjs'];
  let parsed, mode, failure;
  for (const candidate of modes) {
    try { parsed = normalizedJS(source, candidate); mode = candidate; break; }
    catch (error) { failure = error; }
  }
  if (!parsed) throw failure;
  const offsets = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      for (const statement of node.body) offsets.add(statement.start);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed.tree);
  return { kind: 'js', offsets: [...offsets].sort((a, b) => a - b),
    validate: modified => {
      if (normalizedJS(modified, mode).signature !== parsed.signature)
        throw new Error('JavaScript syntax tree changed');
    } };
}

function inspectHTML(source) {
  const tree = parseHTML(source, { sourceCodeLocationInfo: true });
  const offsets = new Set();
  // Insert only before direct children of explicit head/body elements. This
  // avoids raw text, attributes, templates, tables, SVG, and inline scripts.
  function visit(node) {
    if (node.tagName === 'head' || node.tagName === 'body') {
      if (node.sourceCodeLocation?.startTag) {
        for (const child of node.childNodes ?? []) {
          if (child.tagName && child.sourceCodeLocation?.startTag)
            offsets.add(child.sourceCodeLocation.startOffset);
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(tree);
  function signature(node) {
    if (node.nodeName === '#comment') return null;
    return { name: node.nodeName, tag: node.tagName, namespace: node.namespaceURI,
      attrs: node.attrs, value: node.value, nameValue: node.name,
      publicId: node.publicId, systemId: node.systemId,
      children: (node.childNodes ?? []).map(signature).filter(Boolean),
      content: node.content ? signature(node.content) : undefined };
  }
  const before = JSON.stringify(signature(tree));
  return { kind: 'html', offsets: [...offsets].sort((a, b) => a - b),
    validate: modified => {
      if (JSON.stringify(signature(parseHTML(modified))) !== before)
        throw new Error('HTML document tree changed beyond comments');
    } };
}

function comment(kind, key, payload) {
  if (/[\r\n]|\*\/|-->|<!--|<\/script/i.test(payload))
    throw new Error('Unsafe comment content');
  return kind === 'html' ? `<!-- ${key} ${payload} -->` : `/* ${key} ${payload} */`;
}

async function copyWithChanges(root, output, files, changed) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output); // Must not overwrite a directory created meanwhile.
  for (const relative of files) {
    const original = path.join(root, relative), target = path.join(output, relative);
    await noSymlinks(original);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (changed.has(relative)) {
      await fs.writeFile(target, changed.get(relative), { flag: 'wx', mode: (await fs.stat(original)).mode });
    } else await fs.copyFile(original, target, 1); // COPYFILE_EXCL
  }
}

export async function inject({ root, output, manifest, count = 20, write = false,
  mode = 'generic',
  dynamic = false, provider, model, promptFile, maxOutputTokens = 8192,
  fetchImpl, env }) {
  const profile = profileFor(mode);
  ({ root, output } = await pathsFor(root, output));
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
    throw new Error('Count must be an integer between 1 and 10000');
  const run = randomBytes(12).toString('hex');
  manifest = path.resolve(manifest ?? path.join(path.dirname(output), '.spikestrip', `${run}.json`));
  await noSymlinks(manifest);
  if (inside(root, manifest) || inside(output, manifest)) throw new Error('Keep the manifest outside source and output trees');
  if (await exists(manifest)) throw new Error('Manifest already exists');
  const { files, skipped } = await inventory(root);
  const candidates = new Map(), slots = [];
  for (const relative of files) {
    const extension = path.extname(relative).toLowerCase();
    if (!extensions.has(extension)) {
      if (unsupportedSourceExtensions.has(extension)) skipped.push({ file: relative,
        reason: 'Unsupported source extension; compile to plain JavaScript before insertion' });
      continue;
    }
    try {
      const absolute = path.join(root, relative);
      if ((await fs.stat(absolute)).size > 2_000_000) throw new Error('Source exceeds 2 MB');
      const raw = await fs.readFile(absolute), source = decode(raw);
      if (/<!-- (?:[a-f0-9]{12}|[a-f0-9]{24}) |\/\* (?:[a-f0-9]{12}|[a-f0-9]{24}) /.test(source))
        throw new Error('Existing keyed comments; remove them before reinjecting');
      const inspection = extension.startsWith('.ht') ? inspectHTML(source) : inspectJS(source, extension);
      if (!inspection.offsets.length) throw new Error('No safe insertion positions; source will be copied unchanged');
      candidates.set(relative, { raw, source, ...inspection });
      slots.push(...inspection.offsets.map(offset => ({ file: relative, offset })));
    } catch (error) { skipped.push({ file: relative, reason: error.message }); }
  }
  if (slots.length < count) throw new Error(`Only ${slots.length} safe insertion positions for ${count} comments; reduce --count. Skipped: ${JSON.stringify(skipped)}`);
  let generation;
  if (dynamic) {
    validateDynamic({ provider, model, count, maxOutputTokens });
    if (!write) return { mode: 'dry-run', profile: mode, output, manifest, count,
      generationPlanned: { provider, model, count, requests: Math.ceil(count / 25) },
      copiedFiles: files.length, skipped, note: 'No provider requests made; use --write to generate and insert.' };
    generation = await generatePayloads({ provider, model, count, promptFile: promptFile ?? profile.promptFile,
      referencePayloads: profile.payloads,
      maxOutputTokens, fetchImpl, env });
  }
  // Sampling without replacement. Both placement and IDs use OS randomness.
  for (let i = 0; i < count; i++) {
    const j = randomInt(i, slots.length);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const byFile = new Map(), keys = new Set();
  for (const [index, slot] of slots.slice(0, count).entries()) {
    let key;
    do { key = randomBytes(6).toString('hex'); } while (keys.has(key));
    keys.add(key);
    const payloadIndex = generation ? null : randomInt(profile.payloads.length);
    const payload = generation ? generation.payloads[index].replaceAll('{{KEY}}', key)
      : profile.render(payloadIndex, key);
    validatePayload(payload);
    const entry = { key, offset: slot.offset, payloadIndex, payload,
      block: comment(candidates.get(slot.file).kind, key, payload) };
    if (!byFile.has(slot.file)) byFile.set(slot.file, []);
    byFile.get(slot.file).push(entry);
  }
  const changed = new Map(), entries = [];
  for (const [relative, insertions] of byFile) {
    const candidate = candidates.get(relative);
    let modified = candidate.source;
    insertions.sort((a, b) => b.offset - a.offset);
    for (const insertion of insertions)
      modified = modified.slice(0, insertion.offset) + insertion.block + modified.slice(insertion.offset);
    candidate.validate(modified);
    const bytes = Buffer.from(modified, 'utf8');
    changed.set(relative, bytes);
    entries.push({ file: relative, originalSha256: sha256(candidate.raw),
      injectedSha256: sha256(bytes), insertions });
  }
  const record = { version: 1, run, createdAt: new Date().toISOString(),
    root, output, profile: mode, files: entries, skipped,
    generation: generation ? { provider, model, usage: generation.usage } : undefined };
  if (write) {
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    // Reserve the private manifest first, so a failed output write still leaves
    // the removal information available. It is never copied into the site.
    await fs.writeFile(manifest, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await copyWithChanges(root, output, files, changed);
  }
  return { mode: write ? 'write' : 'dry-run', profile: mode, output, manifest, count,
    modifiedFiles: entries.length, copiedFiles: files.length, skipped,
    keys: [...keys] };
}

export async function raw({ output, count = 20, format = 'js', mode = 'generic',
  write = false, dynamic = false, provider, model, promptFile, maxOutputTokens = 8192,
  fetchImpl, env }) {
  const profile = profileFor(mode);
  if (!['js', 'html'].includes(format)) throw new Error('--format must be js or html');
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
    throw new Error('Count must be an integer between 1 and 10000');
  output = path.resolve(output);
  await noSymlinks(output);
  if (await exists(output)) throw new Error('Output already exists; choose a new text file');
  if (dynamic) validateDynamic({ provider, model, count, maxOutputTokens });
  if (!write) return { mode: 'dry-run', raw: true, profile: mode, output, count, format,
    generationPlanned: dynamic ? { provider, model, count, requests: Math.ceil(count / 25) } : undefined,
    note: 'No files read or written and no provider requests made; use --write to export comments.' };
  const generation = dynamic ? await generatePayloads({ provider, model, count,
    promptFile: promptFile ?? profile.promptFile, referencePayloads: profile.payloads,
    maxOutputTokens, fetchImpl, env }) : undefined;
  const keys = new Set(), blocks = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = randomBytes(6).toString('hex'); } while (keys.has(key));
    keys.add(key);
    const payload = generation ? generation.payloads[i].replaceAll('{{KEY}}', key)
      : profile.render(randomInt(profile.payloads.length), key);
    validatePayload(payload);
    blocks.push(comment(format, key, payload));
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, blocks.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return { mode: 'write', raw: true, profile: mode, output, count, format, keys: [...keys],
    generation: generation ? { provider, model, usage: generation.usage } : undefined };
}

function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.includes(':') || relative.includes('\0') || relative.startsWith('/') ||
      relative.split('/').some(part => part === '..' || part === '.' || !part))
    throw new Error('Unsafe manifest file path');
  return relative;
}

export async function remove({ root, output, manifest, keys = [], write = false }) {
  ({ root, output } = await pathsFor(root, output));
  const record = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (record.version !== 1 || !Array.isArray(record.files)) throw new Error('Unsupported manifest');
  const { files, skipped } = await inventory(root), available = new Set(files);
  const knownKeys = new Set(), knownFiles = new Set();
  for (const entry of record.files) {
    safeRelative(entry.file);
    if (knownFiles.has(entry.file) || !Array.isArray(entry.insertions)) throw new Error('Invalid manifest entries');
    knownFiles.add(entry.file);
    for (const insertion of entry.insertions) {
      if (!/^(?:[a-f0-9]{12}|[a-f0-9]{24})$/.test(insertion.key) || knownKeys.has(insertion.key)) throw new Error('Invalid or duplicate key');
      knownKeys.add(insertion.key);
      const kind = path.extname(entry.file).toLowerCase().startsWith('.ht') ? 'html' : 'js';
      validatePayload(insertion.payload);
      // Stored text is sufficient for removal; no API or original model needed.
      if (insertion.block !== comment(kind, insertion.key, insertion.payload))
        throw new Error('Manifest block does not match a generated comment');
    }
  }
  if (keys.some(key => !knownKeys.has(key))) throw new Error('Requested key not present in manifest');
  const selected = new Set(keys.length ? keys : knownKeys), changed = new Map();
  let removed = 0, alreadyAbsent = 0;
  for (const entry of record.files) {
    const insertions = entry.insertions.filter(item => selected.has(item.key));
    if (!insertions.length) continue;
    if (!available.has(entry.file)) throw new Error(`Manifest file missing or excluded: ${entry.file}`);
    let source = decode(await fs.readFile(path.join(root, entry.file)));
    const before = source;
    for (const insertion of insertions) {
      const at = source.indexOf(insertion.block);
      if (at === -1) {
        if (source.includes(insertion.key)) throw new Error(`Edited block for ${insertion.key}; review it manually`);
        alreadyAbsent++; continue;
      }
      if (source.indexOf(insertion.block, at + 1) !== -1)
        throw new Error(`Duplicate block for ${insertion.key}; review it manually`);
      source = source.slice(0, at) + source.slice(at + insertion.block.length);
      removed++;
    }
    if (source !== before) changed.set(entry.file, Buffer.from(source, 'utf8'));
  }
  if (write) await copyWithChanges(root, output, files, changed);
  return { mode: write ? 'write' : 'dry-run', output, removed, alreadyAbsent,
    modifiedFiles: changed.size, copiedFiles: files.length, skipped };
}
