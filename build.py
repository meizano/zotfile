"""Build the ZotFile plugin: python build.py  ->  zotfile-<version>.xpi"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = ['manifest.json', 'bootstrap.js', 'prefs.js']
FOLDERS = ['chrome']

version = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))['version']
target = os.path.join(ROOT, 'zotfile-%s.xpi' % version)

with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as xpi:
    for name in FILES:
        xpi.write(os.path.join(ROOT, name), name)
    for folder in FOLDERS:
        for path, dirs, names in os.walk(os.path.join(ROOT, folder)):
            for name in sorted(names):
                if name == '.DS_Store':
                    continue
                full = os.path.join(path, name)
                xpi.write(full, os.path.relpath(full, ROOT).replace(os.sep, '/'))

print(target)
