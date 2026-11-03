import json
import tempfile
import unittest
from pathlib import Path
from prepare_site import UI_FILES, package, relative_asset


class PackagingTest(unittest.TestCase):
    def test_sprite_is_copied_and_private_files_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in UI_FILES:
                (root / name).write_text('', encoding='utf-8')
            sprite = root / 'assets/items/mod/variant.png'
            sprite.parent.mkdir(parents=True)
            sprite.write_bytes(b'sprite')
            (root / 'catalog.json').write_text(json.dumps({
                'items': [{'icon': 'assets/items/mod/variant.png'}], 'recipes': []}))
            (root / 'private.dat').write_bytes(b'private')
            (root / 'data').mkdir()
            (root / 'data/quests.json').write_text('[]')
            (root / 'data/private.json').write_text('{"private":true}')
            package(root)
            self.assertEqual((root / '_site/assets/items/mod/variant.png').read_bytes(), b'sprite')
            self.assertFalse((root / '_site/private.dat').exists())
            self.assertTrue((root / '_site/knowledge.js').is_file())
            self.assertTrue((root / '_site/data/quests.json').is_file())
            self.assertFalse((root / '_site/data/private.json').exists())

    def test_unsafe_paths_are_rejected(self):
        for value in ('../secret.png', '/secret.png', '//server/file.png',
                      'assets/items/%2e%2e/%2e%2e/secret.png', 'C:/secret.png',
                      'assets\\items\\x.png', 'https://example.org/x.png'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                relative_asset(value)

    def test_stale_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '_site').mkdir()
            (root / '_site/old.dat').write_text('old')
            with self.assertRaisesRegex(ValueError, 'empty'):
                package(root)


if __name__ == '__main__':
    unittest.main()
