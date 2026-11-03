import unittest
from prepare_web_data import apply_display_grid


class ExtremeGridTest(unittest.TestCase):
    def setUp(self):
        self.metadata = {'omnicraft.type': {'id': {'value': 'Avaritia:extreme_shaped_crafting'}}}
        self.recipe = {'id': 'test', 'type': 'extreme_crafting', 'inputs': [
            {'itemId': 'a', 'screenX': 129, 'screenY': 3},
            {'itemId': 'b', 'screenX': 3, 'screenY': 147},
        ]}

    def test_preserves_empty_edges_and_positions(self):
        self.assertTrue(apply_display_grid(self.recipe, self.metadata))
        self.assertEqual((self.recipe['width'], self.recipe['height']), (9, 9))
        self.assertEqual([s['slot'] for s in self.recipe['inputs']], [7, 72])

    def test_shapeless_is_not_given_a_shaped_grid(self):
        self.metadata['omnicraft.type']['id']['value'] = 'Avaritia:extreme_shapeless_crafting'
        self.assertFalse(apply_display_grid(self.recipe, self.metadata))
        self.assertNotIn('width', self.recipe)

    def test_invalid_or_duplicate_coordinates_fail(self):
        self.recipe['inputs'][0]['screenX'] = 4
        with self.assertRaises(ValueError):
            apply_display_grid(self.recipe, self.metadata)
        self.recipe['inputs'] = [self.recipe['inputs'][1].copy()] * 2
        with self.assertRaises(ValueError):
            apply_display_grid(self.recipe, self.metadata)


if __name__ == '__main__':
    unittest.main()
