#!/usr/bin/env node
import { inject, remove } from '../src/spikestrip.mjs';

const help = `SpikeStrip — reversible source comments

node bin/spikestrip.mjs inject ROOT --output COPY [--count 20] [--manifest FILE] [--write]
node bin/spikestrip.mjs remove ROOT --output CLEAN --manifest FILE [--key ID ...] [--write]

Dynamic generation (requires --write to contact a provider):
  inject ROOT --output COPY --dynamic --provider openai|anthropic --model MODEL
              [--count 20] [--prompt-file FILE] [--max-output-tokens 8192] --write

Dry run unless --write is supplied. Originals stay untouched.
Supports HTML and plain JavaScript (.js, .mjs, .cjs), including built bundles.
Keep manifests outside the web root. Repeated --key selects individual comments.
`;

try {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(help);
  } else {
    const command = argv.shift(), root = argv.shift();
    if (!['inject', 'remove'].includes(command) || !root || root.startsWith('--'))
      throw new Error(help);
    const options = { root, keys: [] };
    while (argv.length) {
      const flag = argv.shift();
      if (flag === '--write' || flag === '--dynamic') { options[flag.slice(2)] = true; continue; }
      if (!['--output', '--manifest', '--count', '--key', '--provider', '--model',
        '--prompt-file', '--max-output-tokens'].includes(flag))
        throw new Error(`Unknown option: ${flag}`);
      const value = argv.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--key') options.keys.push(value);
      else {
        const property = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        options[property] = ['--count', '--max-output-tokens'].includes(flag) ? Number(value) : value;
      }
    }
    if (!options.output) throw new Error('--output is required');
    if (command === 'remove' && !options.manifest) throw new Error('--manifest is required for removal');
    if (command === 'inject' && options.keys.length) throw new Error('--key is only valid for removal');
    if (command === 'remove' && options.count !== undefined) throw new Error('--count is only valid for injection');
    const generationOptions = ['provider', 'model', 'promptFile', 'maxOutputTokens'];
    if (command === 'remove' && (options.dynamic || generationOptions.some(key => options[key] !== undefined)))
      throw new Error('Dynamic options are only valid for injection');
    if (!options.dynamic && generationOptions.some(key => options[key] !== undefined))
      throw new Error('Generation options require --dynamic');
    console.log(JSON.stringify(await (command === 'inject' ? inject : remove)(options), null, 2));
  }
} catch (error) {
  console.error(`SpikeStrip: ${error.message}`);
  process.exitCode = 1;
}
