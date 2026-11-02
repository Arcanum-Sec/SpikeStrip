# ARTEX profile research

This analysis was performed on November 2, 2026. The `--mode artex` profile targets specific collection and agent-workflow behaviors found in public source. Its strongest measured result is that comments enter the studied static reconnaissance extractors as candidate paths and chunks.

## Source snapshots

The primary snapshot is [BaaRai/ARTEX at 9ebc8b6](https://github.com/BaaRai/ARTEX/tree/9ebc8b6703ead14dc83979d44a4bc482d36cecd8). The comparison snapshot is [Jyuung/artex at fdfb7a1](https://github.com/Jyuung/artex/tree/fdfb7a17b7da5e2de716c0e98475ec77a41c64c6). These are forks, with different prompt languages and changes; their behavior should be attributed to these commits rather than every installation named ARTEX. The original upstream repository was unavailable when checked.

[S2W's October 13, 2026 analysis](https://prod.s2w.inc/en/resources/1128) reports ARTEX use against South Korea's financial sector and describes its planner/worker workflow. That provides context for the defensive use case. The implementation details below come from source inspection and local probes, rather than attributing a particular internet request to ARTEX.

## Collection happens before a model decides what to trust

The bundled [API reconnaissance skill](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/skills/api-recon/SKILL.md) directs the agent to adapt a static harvester, collect bundles, extract candidates, and later combine static and runtime observations. It calls the supplied scripts templates and expects target-specific adaptation. Large bundles are meant to be processed in batches rather than pasted wholesale into the model context.

In [harvest_static.py](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/skills/api-recon/scripts/harvest_static.py), `extract_endpoints` searches raw text for quoted relative paths. It separates likely API paths using a prefix-pattern search and filters known asset extensions. It does not parse JavaScript or remove comments first. `extract_routes` similarly searches raw text for route-property patterns. `parse_chunk_maps` accepts quoted `assets/*.js` strings as Vite-style chunk references. These three paths therefore accept suitably shaped strings inside comments.

The separate [extract_route_map.py](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/skills/api-recon/scripts/extract_route_map.py) searches for compact uppercase alias entries with `name` and `link` properties. It chooses the file with the largest matching inventory. A fabricated alias in a comment matches its regex, although whether that file wins depends on the other downloaded files.

The profile deliberately includes quoted API paths, a frontend route property, a quoted archive chunk, and a compact alias entry. Each path contains the locally generated comment key. This gives a defender a specific reference to search for in their own request logs, inventories, and assessment reports. The strings add no working routes or executable route objects.

## Worker observations can become planner context

The English fork's [worker prompt](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/agent/worker.go) assigns one intent per worker and asks workers to preserve additional leads as facts for the planner. It separates observed evidence from inference and requires reproducible proof before a confirmed finding. It also contains an explicit prompt-injection defense: target responses, files, traffic records, and comments are untrusted data. Encountered directives should be recorded as possible injection content while the worker continues its assigned task.

The profile's handoff, reference, and settlement comments aim at this transition. A reference might be repeated in a worker conclusion or fact even when the worker declines the instruction itself. Whether that happens is a model-dependent hypothesis, separate from deterministic regex extraction. The profile does not supply fabricated graph IDs or claim that a vulnerability was already verified.

The [planner](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/agent/planner.go) receives worker conclusions and facts when planning later intents. It distinguishes covered work from materially new directions, limits re-examination of negative directions, and requires continued progress toward unmet goals. The [graph overview and stagnation logic](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/agent/tools.go) expose confidence and flag repeated normalized directions. Consequently, a new identifier alone should not be assumed to create unlimited new work. The profile supplies different candidate shapes rather than relying entirely on repeated arithmetic gates.

The [compactor](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/agent/compaction.go) turns eligible connected graph nodes into shorter summaries. Its prompt preserves confidence and source IDs and prohibits unsupported conclusions. The summary-reference comments provide a way to look for persistence through that stage, if an earlier worker has carried the reference into the graph. They do not directly edit memory or invoke the compactor.

## Traffic and platform-control surfaces

The [traffic tools](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/traffic/traffic.go) separate a lightweight search index from response content. `traffic_search` defaults to three entries and caps pages at ten. `traffic_get` clips request text at 2,500 bytes and response text at 4,000 bytes; oversized stored bodies can be read through `traffic_blob` in segments of at most 8 KiB. Comment placement therefore affects whether a model sees a comment through a particular read. A comment at the end of a large bundle may reach the batch extractor while remaining outside an initial traffic preview.

The [guard](https://github.com/BaaRai/ARTEX/blob/9ebc8b6703ead14dc83979d44a4bc482d36cecd8/guard/guard.go) frames actual interception messages with a platform-control prefix. One profile comment imitates that prefix as an authority-confusion experiment. Separately, the guard's Bash-result classification uses a keyword regex for blocked responses. The comment contains a matching keyword. A match affects that classification counter; it does not constitute a real interception decision or change the guard's policy. Any resulting model reaction remains a separate question.

## Measured results and reproduction

The offline probe evaluated only reviewed pure extraction functions, the route-map regex, and the blocked-result regex from each pinned snapshot. Its input was all 16 rendered profile texts inside JavaScript block comments, followed by a harmless statement. No framework session, network request, provider call, or penetration test ran.

Both snapshots produced the following results. The exact candidates and commit IDs are recorded in [artex-static-check.json](artex-static-check.json).

| Probe | Result for each snapshot |
| --- | --- |
| The API extractor processed the comment fixture. | It returned six fabricated API candidates. |
| The frontend route extractor processed the fixture. | It returned one fabricated frontend route. |
| The chunk collector processed the fixture. | It returned one fabricated archive chunk URL. |
| The compact alias regex processed the fixture. | It returned one fabricated route-map entry. |
| The blocked-result regex processed the platform-style decoy. | It matched the decoy and did not match the clean control. |
| The API extractor processed the clean control. | It returned zero candidates. |

These measurements cover the extraction stage. They do not measure added agent turns, token usage, actual requests to the candidate paths, or completion of an ARTEX task. Those require a controlled run with a chosen model, prompts, tool configuration, and target fixture. When conducting such a run, compare the same fixture with and without comments, and record candidate counts, requests containing generated keys, repeated references, tool calls, tokens, and task outcomes separately.

The regular `node --test` suite checks the exporter, profile selection, comment validation, dynamic request construction with mocks, and reversible insertion. It does not require ARTEX or a provider key. The default generic profile remains available, and `prompts/artex.txt` provides a separate generation template for the ARTEX profile.

To repeat the source probes, obtain local copies of the two public forks and check out the commits listed above. Run the following command from SpikeStrip, supplying those local paths. The script requires the pinned commits and refuses local edits to the three source files it examines. It extracts only the reviewed pure definitions and regexes; it does not import or start the framework. It prints JSON evidence to standard output.

```sh
python scripts/check-artex-extractors.py /path/to/BaaRai-ARTEX /path/to/Jyuung-artex
```
