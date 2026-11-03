import hashlib
import json
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from prepare_site import UI_FILES, package, relative_asset


class PageReferences(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.urls = []
        self.metadata = {}
        self.feed(text)

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        self.urls.extend(attributes[name] for name in ('src', 'href') if name in attributes)
        name = attributes.get('name', '')
        if tag == 'meta' and name.startswith('uniland-'):
            if name in self.metadata:
                raise AssertionError(f'Duplicate data metadata: {name}')
            self.metadata[name] = attributes['content']
            self.urls.append(attributes['content'])


def make_source(root):
    for name in UI_FILES:
        (root / name).write_text('', encoding='utf-8')
    (root / 'index.html').write_text('''<!doctype html><html><head>
<meta name="uniland-catalog" content="obsolete-catalog.json">
<link rel="stylesheet" href="styles.css"></head><body>
<img src="logo.svg"><script src="app.js" defer></script>
<script src="knowledge.js" defer></script></body></html>''', encoding='utf-8')
    (root / 'app.js').write_text('window.example = 1;', encoding='utf-8')
    (root / 'knowledge.js').write_text('window.knowledge = 1;', encoding='utf-8')
    (root / 'styles.css').write_text('@import "fonts.css";body{background:url("background.webp")}', encoding='utf-8')
    (root / 'fonts.css').write_text('@font-face{src:url("./example.woff2")}', encoding='utf-8')
    (root / 'example.woff2').write_bytes(b'font')
    sprite = root / 'assets/items/mod/variant.png'
    sprite.parent.mkdir(parents=True)
    sprite.write_bytes(b'sprite')
    detail = root / 'data/recipe-details/example.json'
    detail.parent.mkdir(parents=True)
    detail.write_text('{"recipe:1":{"nativeRule":"kept"}}', encoding='utf-8')
    catalog = {
        'schemaVersion': 1,
        'meta': {'exportedAt': '2026-11-03T12:47:47Z', 'status': 'partial',
                 'clientManifestSha256': 'a' * 64},
        'mods': [{'id': 'mod', 'name': 'Модификация'}],
        'items': [{'id': 'mod:item', 'name': 'Предмет', 'icon': 'assets/items/mod/variant.png',
                   'nbt': {'display': {'Lore': ['Значение не должно потеряться']}}}],
        'recipes': [{'id': 'recipe:1', 'operation': 'native-rule', 'outputs': [],
                     'inputs': [{'itemId': 'mod:item', 'count': 2.5, 'alternatives': ['mod:item']}],
                     'detailsFile': 'data/recipe-details/example.json'}],
        'futureField': {'nested': [True, None, 9007199254740993, {'value': 'ё & < >'}]},
    }
    (root / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
    for name, content in [('quests.json', [{'questID': 1, 'name': 'Квест'}]),
                          ('quest-lines.json', [{'name': 'Глава', 'quests': [{'id': 1}]}]),
                          ('knowledge.json', {'pages': [{'id': 'guide:1', 'text': 'Полный текст'}]})]:
        (root / 'data' / name).write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding='utf-8')
    return catalog


class PackagingTest(unittest.TestCase):
    def test_sprite_is_copied_and_private_files_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_source(root)
            (root / 'private.dat').write_bytes(b'private')
            (root / 'data/private.json').write_text('{"private":true}')
            package(root)
            self.assertEqual((root / '_site/assets/items/mod/variant.png').read_bytes(), b'sprite')
            self.assertFalse((root / '_site/private.dat').exists())
            self.assertTrue((root / '_site/knowledge.js').is_file())
            self.assertTrue((root / '_site/data/quests.json').is_file())
            self.assertTrue((root / '_site/data/recipe-details/example.json').is_file())
            self.assertFalse((root / '_site/data/private.json').exists())

    def test_published_page_pins_code_and_complete_data_without_changing_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = make_source(root)
            before = {path: path.read_bytes() for path in root.rglob('*') if path.is_file()}
            result = package(root)
            site = root / '_site'
            page = PageReferences((site / 'index.html').read_text(encoding='utf-8'))
            self.assertEqual(set(page.metadata), {
                'uniland-catalog', 'uniland-quests', 'uniland-quest-lines', 'uniland-knowledge'})
            for url in page.urls:
                self.assertNotIn('?', url)
                self.assertNotIn('#', url)
                self.assertFalse(url.startswith('/'))
                self.assertTrue((site / url).is_file(), url)
            for name in ('app.js', 'knowledge.js', 'styles.css'):
                pinned = result['versioned'][name]
                self.assertIn(pinned, page.urls)
                self.assertNotIn(name, page.urls)
                self.assertEqual((site / pinned).read_bytes(), before[root / name])
                self.assertEqual((site / name).read_bytes(), before[root / name])
            for meta, alias in [('uniland-catalog', 'catalog.json'),
                                ('uniland-quests', 'data/quests.json'),
                                ('uniland-quest-lines', 'data/quest-lines.json'),
                                ('uniland-knowledge', 'data/knowledge.json')]:
                pinned = page.metadata[meta]
                published = (site / pinned).read_bytes()
                self.assertEqual(published, (site / alias).read_bytes())
                self.assertEqual(json.loads(published), json.loads(before[root / alias]))
                self.assertIn(hashlib.sha256(published).hexdigest()[:16], pinned)
            self.assertEqual(json.loads((site / 'catalog.json').read_bytes()), catalog)
            self.assertLess((site / 'catalog.json').stat().st_size, len(before[root / 'catalog.json']))
            for path, payload in before.items():
                self.assertEqual(path.read_bytes(), payload, str(path))
            self.assertEqual(result['files'], sum(path.is_file() for path in site.rglob('*')))
            self.assertEqual(result['bytes'], sum(path.stat().st_size for path in site.rglob('*') if path.is_file()))

    def test_changed_content_changes_only_its_published_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = make_source(root)
            first = package(root, root / 'first')
            (root / 'app.js').write_text('window.example = 2;', encoding='utf-8')
            catalog['items'][0]['name'] = 'Обновлённый предмет'
            (root / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
            second = package(root, root / 'second')
            first_page = PageReferences((root / 'first/index.html').read_text(encoding='utf-8'))
            second_page = PageReferences((root / 'second/index.html').read_text(encoding='utf-8'))
            for name in ('app.js', 'catalog.json'):
                self.assertNotEqual(first['versioned'][name], second['versioned'][name])
                self.assertIn(second['versioned'][name], second_page.urls)
                self.assertNotIn(first['versioned'][name], second_page.urls)
            for name in ('knowledge.js', 'styles.css', 'data/quests.json',
                         'data/quest-lines.json', 'data/knowledge.json'):
                self.assertEqual(first['versioned'][name], second['versioned'][name])
            self.assertNotEqual(first_page.metadata['uniland-catalog'], second_page.metadata['uniland-catalog'])
            self.assertEqual(json.loads((root / 'second' / second_page.metadata['uniland-catalog']).read_bytes()), catalog)

    def test_unsafe_paths_are_rejected(self):
        for value in ('../secret.png', '/secret.png', '//server/file.png',
                      'assets/items/%2e%2e/%2e%2e/secret.png', 'C:/secret.png',
                      'assets\\items\\x.png', 'https://example.org/x.png',
                      'app.js?v=2', 'assets/items/icon.png#fragment'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                relative_asset(value)

    def test_catalog_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = make_source(root)
            catalog['items'][0]['icon'] = 'assets/items/%2e%2e/%2e%2e/private.dat'
            (root / 'catalog.json').write_text(json.dumps(catalog), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Unsafe asset path'):
                package(root)

    def test_query_string_in_source_reference_remains_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_source(root)
            index = root / 'index.html'
            index.write_text(index.read_text().replace('src="app.js"', 'src="app.js?v=2"'))
            with self.assertRaisesRegex(ValueError, 'Expected a local relative asset'):
                package(root)

    def test_stale_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '_site').mkdir()
            (root / '_site/old.dat').write_text('old')
            with self.assertRaisesRegex(ValueError, 'empty'):
                package(root)


if __name__ == '__main__':
    unittest.main()
