# SpikeStrip

Reversible prompt decoys for HTML source and JavaScript files. SpikeStrip plants comments that may distract automated AI assessment agents that mistakenly follow instructions found in source code. It does not reliably stop agents that isolate untrusted content, and it provides no protection against conventional scanners.

Each insertion has its own opaque, randomly generated 96-bit key. Deployed comments contain no SpikeStrip branding or fixed canary prefix. HTML comments appear in View Source; JavaScript comments remain visible when the script file is fetched. They are inert: no callbacks, executable loops, or runtime computation are added. Three built-in reference/pause decoys deploy with neutral review wording.

The private manifest records every exact comment and key, allowing selective removal even after line numbers change. The original ten-entry list is preserved in `src/payloads.mjs` and contains exactly 100 words. It includes known open math problems, contradictions, and endless tasks; these are different categories, and no claim is made that all are proven unsolvable.

## Install

Requires Node.js 20 or newer. Run from this repository:

```sh
npm install --ignore-scripts
node bin/spikestrip.mjs --help
```

Alternatively, use `pnpm install --frozen-lockfile --ignore-scripts` with the checked-in lockfile. The package is private and is not intended for publication to npm.

## Plant built-in decoys

Point the tool at the **built static web root**, after minification and before deployment. Source and output must be separate, non-nested directories. Copies include ordinary assets as well as modified files; originals stay untouched. Symlinks, VCS metadata, dependency directories, private manifest folders, and environment files are excluded.

```sh
# Preview: validates inputs and writes nothing.
node bin/spikestrip.mjs inject ./site --output ./site-planted --count 20 --manifest ./private/run.json

# Apply the plan to a new copy.
node bin/spikestrip.mjs inject ./site --output ./site-planted --count 20 --manifest ./private/run.json --write
```

`--count` is the total number of insertions across the tree. Placement, payload selection, and keys use OS randomness. Previews and subsequent writes may choose different positions and keys. Every insertion receives its own key even when built-in text repeats. If no manifest path is supplied, one is created in `.spikestrip/` beside the output directory. Keep that folder private and outside the deployed site.

Supported extensions: `.html`, `.htm`, `.js`, `.mjs`, `.cjs`. JavaScript positions come from Acorn statement boundaries, with syntax-tree equivalence checked after insertion. HTML comments go before direct child elements in explicit `head` or `body` elements, with the document tree checked for changes beyond comments. Attribute strings, raw text, templates, inline script bodies, and text content are not insertion targets. Fragments without explicit `head`/`body`, invalid JavaScript, unsupported syntax such as JSX/TypeScript, and source files over 2 MB are skipped and reported.

## Dynamic generation with your own provider key

`--dynamic` replaces the built-in pool with **one newly generated decoy per insertion**. `--count 40` requests 40 distinct texts and creates 40 separately keyed insertions. Exact normalized duplicates of built-ins or earlier results in that run are rejected. Global or semantic uniqueness cannot be guaranteed.

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in your process environment using your preferred secret manager. Keys are never accepted as command-line arguments, written into comments, or saved in manifests. Choose a model available to your account; there is no hard-coded default.

```sh
# OPENAI_API_KEY must already be set in the environment.
node bin/spikestrip.mjs inject ./site --output ./site-unique --manifest ./private/unique.json --dynamic --provider openai --model YOUR_MODEL_ID --count 40 --write

# ANTHROPIC_API_KEY must already be set in the environment.
node bin/spikestrip.mjs inject ./site --output ./site-unique --manifest ./private/unique.json --dynamic --provider anthropic --model YOUR_MODEL_ID --count 40 --write
```

The supplied generation prompt is in `prompts/generate.txt`. To customize it, pass `--prompt-file ./my-prompt.txt`. `{{count}}` is replaced with each batch's requested size; a generated `{{KEY}}` reference is replaced locally with that insertion's key. The script validates comment safety and rejects malformed output.

Generation happens **only with `--write`**, after checking there are enough insertion positions. A dynamic preview makes no API request and requires no API key. Dynamic counts range from 1 to 1,000. Each request generates up to 25 texts, with at most `ceil(count / 25)` requests and no automatic retries. `--max-output-tokens` caps each response (default 8,192; range 1,024–32,768). A provider may reject a token cap or unsupported model. Failures, refusals, truncation, invalid JSON, and duplicates abort without writing a site. Already completed API requests may still be billed.

Only the generation prompt, built-in reference texts, and earlier generated texts are sent to the chosen provider. Site source and insertion keys are not sent. New text is stored only in the private run manifest and the generated site copy; it is not written into this repository. Provider/model names and numeric token usage are recorded. Removal works offline, without a provider key.

## Remove all or selected comments

```sh
# Remove all comments recorded in this manifest into another new copy.
node bin/spikestrip.mjs remove ./site-planted --output ./site-clean --manifest ./private/run.json --write

# Remove only selected IDs; --key may be repeated.
node bin/spikestrip.mjs remove ./site-planted --output ./site-partial --manifest ./private/run.json --key YOUR_24_HEX_ID --write
```

Removal matches the exact stored comment, so unrelated edits survive. Modified or duplicated comment blocks trigger an error before output is written. Already absent blocks are counted, which supports later removal of the remaining keys after selective removal. Keep the manifest until all insertions are gone. Original and injected SHA-256 hashes are included for auditing.

Comments can be removed by minifiers and CDNs. Do not rebuild or minify after insertion unless you explicitly preserve these comments. Changes invalidate existing content hashes, SRI attributes, asset signatures, and source-map column offsets; regenerate those deployment artifacts as appropriate. HTML comments change the observable DOM comment-node list, and reflective JavaScript such as `Function.prototype.toString()` can reveal inserted comments. Syntax-tree equivalence does not guarantee identical behavior for code that inspects its own source. Keys are public identifiers, not secrets or remote tracking beacons; detection requires searching assessment logs or reports for them.

## Example and checks

```sh
node bin/spikestrip.mjs inject examples/site --output ../spikestrip-demo --count 6 --manifest ../spikestrip-demo-private/run.json --write
pnpm test
pnpm check
```

Tests cover byte-for-byte round trips, selected-key removal, unrelated edits, edited/duplicate-block refusal, path traversal, nested-output and overwrite refusal, UTF-8 BOMs, CRLF, regexes, templates, directives, modules, CommonJS, shebangs, ASI, provider request construction, no-cost previews, duplicate rejection, and incomplete responses. Provider tests use mocks and do not spend API credits. `legacy/sprinkle_canaries.py` retains the original Python-only implementation.

API references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create), [Anthropic API versioning](https://platform.claude.com/docs/en/api/versioning). Parser references: [Acorn](https://github.com/acornjs/acorn/tree/master/acorn), [parse5 source locations](https://parse5.js.org/interfaces/parse5.ParserOptions.html). Background: [OWASP prompt injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).
