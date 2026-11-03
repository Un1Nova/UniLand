"""Filter live guide/wiki resources using the actual loaded mod IDs."""
import argparse
import hashlib
import json
import re
from pathlib import Path

import yaml


def applicable(expression, mods):
    if not expression:
        return True
    # The current shipped format uses conjunctions of optionally negated mod IDs.
    # Fail on unfamiliar syntax instead of silently treating a page as applicable.
    terms = expression.split(' and ')
    result = []
    for term in terms:
        match = re.fullmatch(r'(not )?mod:([A-Za-z0-9_\-|]+)', term.strip())
        if not match:
            raise ValueError(f'Unknown requiresMod expression: {expression!r}')
        value = match[2] in mods
        result.append(not value if match[1] else value)
    return all(result)


def frontmatter(text):
    match = re.match(r'\A---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)', text, re.S)
    if not match:
        return {}, text
    metadata = yaml.safe_load(match[1]) or {}
    if not isinstance(metadata, dict):
        raise ValueError('Expected frontmatter object')
    return metadata, text[match.end():]


def export(capture, target):
    if not (capture / 'finished.txt').is_file():
        raise ValueError('Resource capture has not finished')
    session = json.loads((capture / 'session.json').read_text(encoding='utf-8'))
    manifest = json.loads((capture / 'manifest.json').read_text(encoding='utf-8'))
    mods = set(session['mods'])
    pages, excluded, indexes, errors = [], [], [], []
    for entry in manifest:
        resource = entry['resource']
        if 'error' in entry:
            errors.append(entry)
            continue
        raw = (capture / entry['file']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError('Resource hash mismatch')
        if resource.endswith(('.yml', '.yaml')):
            indexes.append({'resource': resource, 'yaml': raw.decode('utf-8'), 'sha256': entry['sha256']})
            continue
        if not resource.endswith('.md'):
            continue
        text = raw.decode('utf-8')
        meta, body = frontmatter(text)
        requirement = meta.get('requiresMod', '')
        if not applicable(requirement, mods):
            excluded.append({'resource': resource, 'requiresMod': requirement})
            continue
        language = next((part for part in resource.split('/') if re.fullmatch('[a-z]{2}_[a-z]{2}', part)), None)
        pages.append({'resource': resource, 'kind': 'guide' if resource.startswith('luminous:guides/') else 'wiki',
                      'language': language, 'metadata': meta, 'markdown': body,
                      'sourceMarkdown': text, 'sha256': entry['sha256']})
    result = {'schemaVersion': 1, 'source': 'LoliLand TechnoMagic RPG', 'exportedAt': session['observedAt'],
              'runtimeExport': True, 'resolution': session['resolution'],
              'loadedModIds': sorted(mods), 'sourceResourceCount': len(manifest),
              'pages': pages, 'navigationSources': indexes, 'excludedByModRequirements': excluded,
              'captureErrors': errors,
              'notes': ['Source Markdown and custom game markup are preserved verbatim.',
                        'Mod applicability is verified; GUI/item lookup targets require separate registry validation.']}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    return {'guides': sum(p['kind'] == 'guide' for p in pages), 'wikiPages': sum(p['kind'] == 'wiki' for p in pages),
            'excludedPages': len(excluded), 'captureErrors': len(errors)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.capture, args.target)))
