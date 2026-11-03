"""Regression checks for layouts and tiny values in both actual validators."""
import copy
import importlib.util
import json
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', ROOT / 'build-catalog.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixture():
    return {'schemaVersion': 1, 'mods': [],
            'meta': {'status': 'partial', 'exportedAt': datetime.now(timezone.utc).isoformat(),
                     'coverage': {'runtimeExport': True}},
            'items': [{'id': 'test:a', 'name': 'A'}, {'id': 'test:b', 'name': 'B'}],
            'recipes': [{'id': 'test:r', 'type': 'shaped', 'verification': 'runtime',
                         'width': 2, 'height': 1,
                         'inputs': [{'itemId': 'test:a', 'count': 1, 'slot': 0}],
                         'outputs': [{'itemId': 'test:b', 'count': 0.00000001, 'chance': 0.00000001}]}]}


class ContractTest(unittest.TestCase):
    def check_both(self, catalog, valid):
        if valid:
            builder.validate(catalog)
        else:
            with self.assertRaises(ValueError):
                builder.validate(catalog)
        js = (ROOT / 'app.js').read_text(encoding='utf-8')
        validator = js[js.index('  function validateCatalog('):js.index('  function image(')]
        program = validator + '\ntry {validateCatalog(JSON.parse(require("fs").readFileSync(0,"utf8")));process.stdout.write("valid")}catch(e){process.stdout.write("invalid")}'
        result = subprocess.run(['node', '-e', program], input=json.dumps(catalog),
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, 'valid' if valid else 'invalid')

    def test_valid_tiny_values(self):
        self.check_both(fixture(), True)
        js = (ROOT / 'app.js').read_text(encoding='utf-8')
        formatter = js[js.index('  const numberFormat'):js.index('  const norm')]
        result = subprocess.run(['node', '-e', formatter + '\nprocess.stdout.write(num(0.00000001))'],
                                capture_output=True, text=True, check=True)
        self.assertNotEqual(result.stdout, '0')

    def test_duplicate_slots(self):
        data = fixture()
        data['recipes'][0]['inputs'].append(copy.deepcopy(data['recipes'][0]['inputs'][0]))
        self.check_both(data, False)

    def test_slot_requires_dimensions(self):
        data = fixture()
        del data['recipes'][0]['width']
        del data['recipes'][0]['height']
        self.check_both(data, False)

    def test_null_or_incomplete_grid(self):
        for value in (None, 0, 10):
            data = fixture()
            data['recipes'][0]['width'] = value
            self.check_both(data, False)
        data = fixture()
        del data['recipes'][0]['height']
        self.check_both(data, False)

    def test_unknown_alternative(self):
        data = fixture()
        data['recipes'][0]['inputs'][0]['alternatives'] = ['missing']
        self.check_both(data, False)


if __name__ == '__main__':
    unittest.main()
