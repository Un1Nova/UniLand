"""Normalize definition-only NBT captures; never reads BetterQuesting player progress."""
import argparse
import hashlib
import io
import json
import math
import struct
from pathlib import Path


class NBTReader:
    def __init__(self, data):
        self.stream = io.BytesIO(data)

    def read(self, size):
        value = self.stream.read(size)
        if len(value) != size:
            raise ValueError('Truncated NBT')
        return value

    def number(self, fmt):
        return struct.unpack('>' + fmt, self.read(struct.calcsize('>' + fmt)))[0]

    def string(self):
        # Java DataInput.readUTF uses modified UTF-8, including encoded UTF-16 surrogates.
        raw = self.read(self.number('H')).replace(b'\xc0\x80', b'\x00')
        return raw.decode('utf-8', 'surrogatepass').encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'surrogatepass')

    def length(self):
        count = self.number('i')
        if count < 0 or count > 10_000_000:
            raise ValueError('Invalid NBT length')
        return count

    def payload(self, kind):
        tag = {'type': kind}
        if kind in {1, 2, 3, 4, 5, 6}:
            val = self.number({1: 'b', 2: 'h', 3: 'i', 4: 'q', 5: 'f', 6: 'd'}[kind])
            # Preserve int64 beyond JavaScript's exact integer range.
            tag['value'] = str(val) if kind == 4 else val
            if isinstance(val, float) and not math.isfinite(val):
                tag['value'] = str(val)
        elif kind == 7:
            tag['value'] = [self.number('b') for _ in range(self.length())]
        elif kind == 8:
            tag['value'] = self.string()
        elif kind == 9:
            element = self.number('B')
            tag['elementType'] = element
            tag['value'] = [self.payload(element) for _ in range(self.length())]
        elif kind == 10:
            entries = {}
            while (child := self.number('B')):
                name = self.string()
                if name in entries:
                    raise ValueError('Duplicate NBT compound key')
                entries[name] = self.payload(child)
            tag['value'] = entries
        elif kind == 11:
            tag['value'] = [self.number('i') for _ in range(self.length())]
        elif kind == 12:
            tag['value'] = [str(self.number('q')) for _ in range(self.length())]
        else:
            raise ValueError(f'Unsupported NBT tag {kind}')
        return tag

    def root(self):
        kind = self.number('B')
        name = self.string()
        root = self.payload(kind)
        if self.stream.read(1):
            raise ValueError('Trailing NBT data')
        return name, root


def plain(tag):
    if tag['type'] == 10:
        return {key: plain(value) for key, value in tag['value'].items()}
    if tag['type'] == 9:
        return [plain(value) for value in tag['value']]
    return tag['value']


def export(capture, target):
    coverage = json.loads((capture / 'coverage.json').read_text(encoding='utf-8'))
    session = json.loads((capture / 'session.json').read_text(encoding='utf-8'))
    collections = {}
    evidence = []
    for filename, class_name, id_key in [('quests', 'QuestDatabase', 'questID'),
                                         ('quest-lines', 'QuestLineDatabase', 'lineID')]:
        raw = (capture / (filename + '.nbt')).read_bytes()
        report = next(row for row in coverage if row['id'] == 'betterquesting.questing.' + class_name)
        if hashlib.sha256(raw).hexdigest() != report['sha256']:
            raise ValueError('Capture hash mismatch')
        _, root = NBTReader(raw).root()
        if root['type'] != 9 or len(root['value']) != report['sourceCount']:
            raise ValueError('Quest count mismatch')
        definitions = []
        ids = set()
        for typed in root['value']:
            definition = plain(typed)
            ident = definition[id_key]
            if ident in ids:
                raise ValueError('Duplicate quest/line ID')
            ids.add(ident)
            props = definition.get('properties', {}).get('betterquesting', {})
            # Both convenient values and the complete typed source are retained.
            definitions.append({'id': ident, 'name': props.get('name', ''),
                                'description': props.get('desc', ''),
                                'definition': definition, 'typedNBT': typed})
        collections[filename] = sorted(definitions, key=lambda q: q['id'])
        evidence.append(report)
    quest_ids = {q['id'] for q in collections['quests']}
    dangling = []
    for q in collections['quests']:
        for dependency in q['definition'].get('preRequisites', []):
            if dependency not in quest_ids:
                dangling.append({'questId': q['id'], 'missingPrerequisite': dependency})
    result = {'schemaVersion': 1, 'source': 'LoliLand TechnoMagic RPG',
              'exportedAt': session['observedAt'], 'runtimeExport': True,
              'scope': 'quest definitions, tasks, rewards, prerequisites and line layouts; excludes player progress',
              'coverage': evidence, 'unresolvedReferences': dangling, **collections}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    return {'quests': len(collections['quests']), 'lines': len(collections['quest-lines']),
            'unresolvedReferences': len(dangling), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.capture, args.target)))
