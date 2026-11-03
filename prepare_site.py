"""Package only public application files and referenced catalog images."""
import argparse
import json
import re
import shutil
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
UI_FILES = ('index.html', 'styles.css', 'fonts.css', 'app.js', 'knowledge.js', 'favicon.svg',
            'logo.svg', 'catalog.json', 'background.webp')
DATA_FILES = ('quests.json', 'quest-lines.json', 'knowledge.json', 'snapshot.json',
              'coverage-report.json', 'client-manifest.json', 'normalization-report.json')


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
        shutil.copyfile(root / path, target)
    # Check references in the final artifact, not just the source directory.
    for name in ('index.html', 'styles.css', 'fonts.css'):
        text = (destination / name).read_text(encoding='utf-8')
        refs = re.findall(r'(?:src|href)=["\']([^"\']+)', text)
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
    return {'files': len(files), 'items': len(catalog['items']), 'recipes': len(catalog['recipes'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(destination=args.destination)))
