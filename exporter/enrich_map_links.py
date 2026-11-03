"""Add page metadata, applicability, section anchors and explicit navigation links."""
import argparse
import collections
import re
from pathlib import Path
from build_map_data import load, save
from export_knowledge import frontmatter, applicable


def enrich(package):
    pages = load(package / 'pages.json')
    runtime = load(package / 'knowledge-runtime.json')
    mods = set(runtime['loadedModIds'])
    active = {p['resource']: p for p in runtime['pages']}
    by_identity = collections.defaultdict(list)
    graph = load(package / 'graph.json')
    # Idempotent enrichment: keep primary recipe, quest and item-mention edges.
    graph['edges'] = [x for x in graph['edges'] if x['relation'] not in ('contains-section', 'links-page')]
    sections, links, missing = [], [], []
    for page in pages:
        metadata, body = frontmatter(page['markdown'])
        page['metadata'] = metadata
        page['bodyMarkdown'] = body
        page['applicableToLoadedMods'] = applicable(metadata.get('requiresMod'), mods)
        resource = page['source']['resource'].replace('assets/luminous/', 'luminous:', 1)
        page['activeResourceVerified'] = resource in active and active[resource]['sha256'] == page['source']['sha256']
        page['sourcePageId'] = metadata.get('id')
        if metadata.get('id'):
            by_identity[metadata['id']].append(page['id'])
        headings = list(re.finditer(r'(?m)^(#{1,6})\s+(.+)$', body))
        for i, heading in enumerate(headings):
            anchor = re.search(r'\{#([^\s}]+)', heading[2])
            section = {'id': page['id'] + '#' + (anchor[1] if anchor else 'heading-' + str(i)),
                       'pageId': page['id'], 'level': len(heading[1]), 'titleMarkup': heading[2],
                       'anchor': anchor[1] if anchor else None,
                       'markdown': body[heading.start():headings[i+1].start() if i+1 < len(headings) else len(body)]}
            sections.append(section)
            graph['edges'].append({'from': page['id'], 'to': section['id'], 'relation': 'contains-section'})
        for target in re.findall(r'\]\((guide:[^)\s]+)\)', body):
            links.append({'from': page['id'], 'target': target})
    section_ids = {x['id'] for x in sections}
    for link in links:
        identity, _, anchor = link['target'][6:].partition('#')
        targets = by_identity.get(identity, [])
        if not targets:
            missing.append(link)
        for target in targets:
            if anchor:
                target += '#' + anchor
                if target not in section_ids:
                    missing.append(link)
                    continue
            graph['edges'].append({'from': link['from'], 'to': target, 'relation': 'links-page'})
    save(package / 'pages.json', pages)
    save(package / 'page-sections.json', sections)
    save(package / 'graph.json', graph)
    save(package / 'navigation.json', {'sources': runtime['navigationSources'], 'links': links, 'unresolvedLinks': missing})
    manifest = load(package / 'manifest.json')
    manifest['counts'].update(edges=len(graph['edges']), pageSections=len(sections),
                              activeGuides=sum(x['kind'] == 'guide' for x in runtime['pages']),
                              activeWikiPages=sum(x['kind'] == 'wiki' for x in runtime['pages']))
    save(package / 'manifest.json', manifest)
    print({'sections': len(sections), 'explicitPageLinks': len(links), 'unresolvedLinks': len(missing)})


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', type=Path)
    enrich(p.parse_args().package)
