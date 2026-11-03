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


def native_rule_fixture():
    """Use the provenance shape of an actual published native-rule record."""
    data = fixture()
    recipe = data['recipes'][0]
    recipe.update({
        'type': 'hemontransmutator',
        'operation': 'native-rule',
        'outputs': [],
        'sources': [{
            'file': 'raw/registries/001a7c85f4bc5a3b1e8af50f0360ca9ec62396b43f59e7fc7efedc935b6e7c22.json',
            'registry': 'luminous:hemontransmutator',
            'index': 0,
        }],
        'detailsFile': 'data/recipe-details/8c67148c89e95127.json',
    })
    del recipe['width']
    del recipe['height']
    del recipe['inputs'][0]['slot']
    return data


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

    def test_native_rule_without_outputs(self):
        self.check_both(native_rule_fixture(), True)

    def test_regular_recipe_requires_outputs(self):
        data = fixture()
        data['recipes'][0]['outputs'] = []
        self.check_both(data, False)

    def test_native_rule_requires_sources(self):
        for present in (False, True):
            with self.subTest(sources_present=present):
                data = native_rule_fixture()
                if present:
                    data['recipes'][0]['sources'] = []
                else:
                    del data['recipes'][0]['sources']
                self.check_both(data, False)

    def test_native_rule_requires_details_file(self):
        for present in (False, True):
            with self.subTest(details_file_present=present):
                data = native_rule_fixture()
                if present:
                    data['recipes'][0]['detailsFile'] = ''
                else:
                    del data['recipes'][0]['detailsFile']
                self.check_both(data, False)

    @unittest.skipUnless((ROOT / 'catalog.json').is_file(), 'No published catalog in this checkout')
    def test_published_catalog_when_present(self):
        # Parse the complete file once per runtime. Do not serialize its 56 MB
        # through stdin or load it again for each small regression fixture.
        path = ROOT / 'catalog.json'
        with path.open(encoding='utf-8') as source:
            catalog = json.load(source)
        builder.validate(catalog)
        del catalog
        js = (ROOT / 'app.js').read_text(encoding='utf-8')
        validator = js[js.index('  function validateCatalog('):js.index('  function image(')]
        program = validator + '\ntry {validateCatalog(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));process.stdout.write("valid")}catch(e){process.stderr.write(e.message);process.stdout.write("invalid")}'
        result = subprocess.run(['node', '-e', program, str(path)],
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, 'valid', result.stderr)


if __name__ == '__main__':
    unittest.main()
