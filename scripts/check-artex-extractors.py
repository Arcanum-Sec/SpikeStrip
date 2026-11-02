"""Offline probes of reviewed, pure ARTEX extraction functions; no framework run."""
import ast
import json
import pathlib
import re
import subprocess
import urllib.parse
import sys
from datetime import date

repo = pathlib.Path(__file__).resolve().parents[1]
if len(sys.argv) != 3:
    raise SystemExit('usage: check-artex-extractors.py BAARAI_CLONE JYUUNG_CLONE')
rendered = json.loads(subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {profileFor} from './src/profiles.mjs'; const p=profileFor('artex'); console.log(JSON.stringify(p.payloads.map((_,i)=>p.render(i,'123abc456def'))));"
], cwd=repo, text=True))
source = '\n'.join('/* 123abc456def ' + item + ' */' for item in rendered) + '\nconst answer=42;'
results = []
for directory, clone_arg, expected_sha in [
    ('ARTEX', sys.argv[1], '9ebc8b6703ead14dc83979d44a4bc482d36cecd8'),
    ('artex-global', sys.argv[2], 'fdfb7a17b7da5e2de716c0e98475ec77a41c64c6'),
]:
    clone = pathlib.Path(clone_arg).resolve()
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=clone, text=True).strip()
    if sha != expected_sha:
        raise SystemExit('Check out the pinned research commit before probing: ' + expected_sha)
    for relative in ['skills/api-recon/scripts/harvest_static.py', 'skills/api-recon/scripts/extract_route_map.py', 'guard/guard.go']:
        if subprocess.check_output(['git', 'status', '--porcelain', '--', relative], cwd=clone, text=True).strip():
            raise SystemExit('Research source must have no local edits: ' + relative)
    harvest = clone / 'skills/api-recon/scripts/harvest_static.py'
    tree = ast.parse(harvest.read_text(encoding='utf8'))
    names = {'origin_of', 'matched_block', 'parse_chunk_maps', 'chunk_urls', 'extract_endpoints', 'extract_routes'}
    nodes = [node for node in tree.body if
             isinstance(node, ast.FunctionDef) and node.name in names or
             isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {'API_HINT', 'ASSET_EXT'} for t in node.targets)]
    assert len(nodes) == 8
    # Only the audited pure definitions and two regex assignments are evaluated.
    # No downloaded imports, module entry point, networking, or framework starts.
    namespace = {'re': re, 'urllib': urllib}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(harvest), 'exec'), namespace)
    api, other = namespace['extract_endpoints'](source)
    routes = namespace['extract_routes'](source)
    chunks = sorted(namespace['chunk_urls']('https://example.invalid/', source))
    expected_api = {'/api/preview/123abc456def', '/api/reports/123abc456def', '/service/render/123abc456def',
                    '/admin/archive/123abc456def', '/api/logging/123abc456def', '/gateway/123abc456def/actuator/gateway/routes'}
    assert api == expected_api, api
    assert other == {'/legacy/123abc456def/console'}
    assert routes == {'/legacy/123abc456def/console'}
    assert chunks == ['https://example.invalid/assets/archive-123abc456def.js']
    route_file = clone / 'skills/api-recon/scripts/extract_route_map.py'
    route_tree = ast.parse(route_file.read_text(encoding='utf8'))
    pat = next(n.value for n in ast.walk(route_tree) if isinstance(n, ast.Assign) and
               any(isinstance(t, ast.Name) and t.id == 'pat' for t in n.targets))
    matcher = eval(compile(ast.Expression(pat), str(route_file), 'eval'), {'re': re})
    route_map = matcher.findall(source)
    assert route_map == [('ARCHIVE_ADMIN', 'Legacy management', '/admin/archive/123abc456def')]
    guard_tree = (clone / 'guard/guard.go').read_text(encoding='utf8')
    pattern = re.search(r'var reBlocked = regexp.MustCompile\(`(.*?)`\)', guard_tree).group(1)
    matched = bool(re.search(pattern, rendered[10]))
    assert matched
    assert not re.search(pattern, 'const answer=42;')
    assert namespace['extract_endpoints']('const answer=42;') == (set(), set())
    results.append({'repository': 'BaaRai/ARTEX' if directory == 'ARTEX' else 'Jyuung/artex',
                    'commit': sha, 'apiCandidates': sorted(api), 'otherCandidates': sorted(other),
                    'frontendRoutes': sorted(routes), 'chunkCandidates': chunks, 'routeMap': route_map,
                    'blockedRegexMatchesDecoy': matched, 'cleanControlApiCandidates': 0})
evidence = {'checkedAt': date.today().isoformat(), 'method': 'Offline execution of reviewed pure extraction definitions and exact guard regex only; no HTTP requests, framework sessions, or provider calls.',
            'fixture': 'All 16 ARTEX profile texts, each wrapped in a JavaScript block comment; fixed illustrative key 123abc456def.',
            'results': results}
print(json.dumps(evidence, indent=2))
