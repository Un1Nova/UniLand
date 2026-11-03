import struct
import unittest
from export_quest_definitions import NBTReader


class NBTReaderTests(unittest.TestCase):
    def test_int64_and_modified_utf8(self):
        raw = b'\x0a\x00\x00\x04\x00\x01n' + struct.pack('>q', -9223372036854775808)
        text = b'\xc0\x80\xed\xa0\xbd\xed\xb8\x80'
        raw += b'\x08\x00\x01s' + struct.pack('>H', len(text)) + text + b'\x00'
        _, root = NBTReader(raw).root()
        self.assertEqual(root['value']['n'], {'type': 4, 'value': '-9223372036854775808'})
        self.assertEqual(root['value']['s']['value'], '\x00\U0001f600')

    def test_rejects_truncation_and_trailing_data(self):
        for raw in (b'\x0a\x00\x00', b'\x0a\x00\x00\x00x'):
            with self.assertRaises(ValueError):
                NBTReader(raw).root()


if __name__ == '__main__':
    unittest.main()
