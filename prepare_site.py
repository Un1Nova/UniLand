"""Package only public application files and referenced catalog images."""
import argparse
import hashlib
import json
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from runtime_catalog import encode_runtime_catalog

ROOT = Path(__file__).resolve().parent
UI_FILES = ('index.html', 'styles.css', 'fonts.css', 'runtime.js', 'app.js', 'knowledge.js',
            'planner-engine.js', 'planner.js', 'planner-worker.js', 'planner.css',
            'viewport.js', 'viewport.css', 'favicon.svg', 'logo.svg', 'catalog.json',
            'background.webp')
DATA_FILES = ('quests.json', 'quest-lines.json', 'knowledge.json', 'snapshot.json',
              'coverage-report.json', 'client-manifest.json', 'normalization-report.json')
VERSIONED_UI_FILES = ('runtime.js', 'app.js', 'knowledge.js', 'styles.css',
                      'planner-engine.js', 'planner.js', 'planner-worker.js', 'planner.css',
                      'viewport.js', 'viewport.css')
DATA_META_FILES = {
    'uniland-catalog': Path('catalog.json'),
    'uniland-quests': Path('data/quests.json'),
    'uniland-quest-lines': Path('data/quest-lines.json'),
    'uniland-knowledge': Path('data/knowledge.json'),
}
ASSET_META_FILES = {
    'uniland-runtime': Path('catalog-runtime.json'),
    'uniland-planner-worker': Path('planner-worker.js'),
}
META_FILES = {**DATA_META_FILES, **ASSET_META_FILES}


class PublishedReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        self.references.extend(attributes[name] for name in ('src', 'href')
                               if attributes.get(name))
        if tag == 'meta' and attributes.get('name') in META_FILES:
            self.references.append(attributes.get('content', ''))


def content_path(path, payload):
    digest = hashlib.sha256(payload).hexdigest()[:16]
    return path.with_name(f'{path.stem}.{digest}{path.suffix}')


def version_index(text, versioned):
    def replace_reference(match):
        value = match.group('value')
        # Leave other references unchanged for the strict artifact check below.
        try:
            replacement = versioned.get(relative_asset(value))
        except ValueError:
            replacement = None
        if replacement is None:
            return match.group(0)
        return (match.group('prefix') + match.group('quote')
                + replacement.as_posix() + match.group('quote'))

    text = re.sub(r'''(?P<prefix>\b(?:src|href)\s*=\s*)(?P<quote>["'])(?P<value>[^"']+)(?P=quote)''',
                  replace_reference, text, flags=re.IGNORECASE)

    def remove_old_data_meta(match):
        name = re.search(r'''\bname\s*=\s*(["'])([^"']+)\1''', match.group(0),
                         flags=re.IGNORECASE)
        return '' if name and name.group(2).lower() in META_FILES else match.group(0)

    text = re.sub(r'<meta\b[^>]*>', remove_old_data_meta, text, flags=re.IGNORECASE)
    metadata = ''.join(f'  <meta name="{name}" content="{versioned[path].as_posix()}">\n'
                       for name, path in META_FILES.items() if path in versioned)
    text, count = re.subn(r'</head\s*>', lambda _: metadata + '</head>', text,
                         count=1, flags=re.IGNORECASE)
    if count != 1:
        raise ValueError('Published index.html must contain a closing head element')
    return text


def relative_asset(value):
    if not isinstance(value, str) or not value:
        raise ValueError('Empty asset path')
    url = urlsplit(value)
    if url.scheme or url.netloc or url.query or url.fragment or '\\' in value:
        raise ValueError(f'Expected a local relative asset: {value}')
    path = Path(unquote(url.path))
    if path.anchor or '..' in path.parts or ':' in str(path):
        raise ValueError(f'Unsafe asset path: {value}')
    return path


def package(root=ROOT, destination=None):
    root = root.resolve()
    destination = (destination or root / '_site').resolve()
    if destination == root or destination in root.parents:
        raise ValueError('Destination must not contain source tree')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Destination must be empty (stale files must not be published)')
    catalog = json.loads((root / 'catalog.json').read_text(encoding='utf-8'))
    # Only publication bytes change: all values and source/release files are preserved.
    catalog_bytes = (json.dumps(catalog, ensure_ascii=False, separators=(',', ':'),
                               allow_nan=False) + '\n').encode('utf-8')
    files = {Path(name) for name in UI_FILES}
    for name in DATA_FILES:
        path = Path('data') / name
        if (root / path).is_file():
            files.add(path)
    files.update(p.relative_to(root) for p in root.glob('*.woff2'))
    for item in catalog['items']:
        if not item.get('icon'):
            continue
        path = relative_asset(item['icon'])
        if path.parts[:2] != ('assets', 'items') or path.suffix.lower() not in ('.png', '.webp'):
            raise ValueError(f'Inventory icon must be PNG/WebP in assets/items: {path}')
        files.add(path)
    for recipe in catalog['recipes']:
        if recipe.get('detailsFile'):
            path = relative_asset(recipe['detailsFile'])
            if path.parts[:2] != ('data', 'recipe-details') or path.suffix != '.json':
                raise ValueError(f'Unexpected recipe details path: {path}')
            files.add(path)
        value = recipe.get('sourceImage')
        if not value or urlsplit(value).scheme in ('https', 'http'):
            continue
        path = relative_asset(value)
        if path.parts[:2] != ('assets', 'recipes') or path.suffix.lower() not in ('.png', '.webp'):
            raise ValueError(f'Unexpected recipe illustration path: {path}')
        files.add(path)
    for path in files:
        source = (root / path).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError(f'Missing or unsafe published asset: {path}')
    destination.mkdir(parents=True, exist_ok=True)
    for path in sorted(files):
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if path == Path('catalog.json'):
            target.write_bytes(catalog_bytes)
        else:
            shutil.copyfile(root / path, target)

    # Keep the old URLs for cached pages, and pin this page to immutable content URLs.
    versioned = {}
    candidates = [Path(name) for name in VERSIONED_UI_FILES] + list(DATA_META_FILES.values())
    for path in candidates:
        if path not in files:
            continue
        payload = catalog_bytes if path == Path('catalog.json') else (root / path).read_bytes()
        hashed_path = content_path(path, payload)
        (destination / hashed_path).write_bytes(payload)
        versioned[path] = hashed_path
    # The complete catalog and details remain published. Only the bootstrap is
    # projected, with shared arrays and exact item references restored by runtime.js.
    runtime_bytes = (json.dumps(encode_runtime_catalog(catalog), ensure_ascii=False,
                               separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    runtime_path = Path('catalog-runtime.json')
    hashed_runtime = content_path(runtime_path, runtime_bytes)
    (destination / hashed_runtime).write_bytes(runtime_bytes)
    versioned[runtime_path] = hashed_runtime
    files.update(versioned.values())
    index = destination / 'index.html'
    index.write_text(version_index(index.read_text(encoding='utf-8'), versioned), encoding='utf-8')

    # Check references in the final artifact, not just the source directory.
    for name in ('index.html', 'styles.css', 'fonts.css', 'planner.css', 'viewport.css'):
        text = (destination / name).read_text(encoding='utf-8')
        if name == 'index.html':
            parser = PublishedReferences()
            parser.feed(text)
            refs = parser.references
        else:
            refs = []
        refs += re.findall(r'url\(["\']?([^\)"\']+)', text)
        refs += re.findall(r'@import\s+["\']([^"\']+)', text)
        for value in refs:
            if value.startswith('#') or urlsplit(value).scheme in ('https', 'http', 'data'):
                continue
            if not (destination / relative_asset(value)).is_file():
                raise ValueError(f'Broken published reference in {name}: {value}')
    for path in files:
        if not (destination / path).is_file():
            raise ValueError(f'Missing packaged file: {path}')
    return {'files': len(files), 'items': len(catalog['items']), 'recipes': len(catalog['recipes']),
            'bytes': sum((destination / path).stat().st_size for path in files),
            'versioned': {path.as_posix(): hashed.as_posix() for path, hashed in versioned.items()}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(destination=args.destination)))
