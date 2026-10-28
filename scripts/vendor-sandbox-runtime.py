"""Reproduce the reviewed consumer fork from a local, integrity-pinned public archive.

No downloads or lifecycle scripts. Temporary compiler inputs are retained for review.
Run from the repository root with --archive PATH and either --output DIR or --check.
"""

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'packages/coding-agent/examples/extensions/sandbox/vendor/sandbox-runtime'
VERSION = '0.0.26-vinci.zod4.1'
ARCHIVE = f'sandbox-runtime-{VERSION}.tgz'
ORIGIN = {
    'url': 'https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.26.tgz',
    'integrity': 'sha512-DYV5LSsVMnzq0lbfaYMSpxZPUMAx4+hy343dRss+pVCLIfF62qOhxpYfZ5TmOk1GTDQm5f9wPprMNSStmnsV4w==',
}
ALIASES = ['NetworkConfig', 'FilesystemConfig', 'IgnoreViolationsConfig',
           'RipgrepConfig', 'SeccompConfig', 'SandboxRuntimeConfig']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def generate(archive):
    assert archive.is_file() and not archive.is_symlink() and archive.stat().st_size < 2_000_000
    compressed = archive.read_bytes()
    assert 'sha512-' + base64.b64encode(hashlib.sha512(compressed).digest()).decode() == ORIGIN['integrity'], 'Upstream archive integrity mismatch'
    original = {}
    with tarfile.open(fileobj=io.BytesIO(compressed), mode='r:gz') as tar:
        for member in tar.getmembers():
            name = Path(member.name)
            assert member.isfile() and name.parts[0] == 'package' and '..' not in name.parts and not name.is_absolute()
            path = '/'.join(name.parts[1:])
            assert path not in original and member.size < 1_000_000
            original[path] = (tar.extractfile(member).read(), member.mode & 0o777)
    assert len(original) == 75 and sum(len(data) for data, _ in original.values()) < 4_000_000
    files = dict(original)
    upstream_js = original['dist/sandbox/sandbox-config.js'][0].decode().split('//# sourceMappingURL=')[0]
    schema = VENDOR.joinpath('schema.ts.txt').read_bytes()
    expected_source = upstream_js + '\n' + ''.join(f'export type {name} = z.infer<typeof {name}Schema>;\n' for name in ALIASES)
    assert schema == expected_source.encode(), 'Schema must be exactly upstream runtime code plus its six type aliases'
    compiler = ROOT / 'node_modules/typescript'
    assert json.loads((compiler / 'package.json').read_text())['version'] == '5.9.3'
    temporary = Path(tempfile.mkdtemp(prefix='sandbox-runtime-reproduce-'))
    source = temporary / 'src/sandbox/sandbox-config.ts'
    source.parent.mkdir(parents=True)
    source.write_bytes(schema)
    (temporary / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (temporary / 'package.json').write_text('{"type":"module"}\n')
    config = {
        'compilerOptions': {'target': 'ES2022', 'module': 'NodeNext', 'moduleResolution': 'NodeNext',
                            'strict': True, 'skipLibCheck': False, 'types': [], 'declaration': True,
                            'sourceMap': True, 'declarationMap': True, 'rootDir': 'src', 'outDir': 'dist'},
        'files': ['src/sandbox/sandbox-config.ts'],
    }
    (temporary / 'tsconfig.json').write_bytes(encoded(config))
    subprocess.run(['node', str(compiler / 'bin/tsc'), '-p', str(temporary / 'tsconfig.json')],
                   check=True, env={key: os.environ[key] for key in ['PATH', 'TMPDIR'] if key in os.environ})
    # Compilation may regenerate maps/declarations, but must not alter even one runtime JS byte.
    emitted_js = (temporary / 'dist/sandbox/sandbox-config.js').read_bytes()
    assert emitted_js.decode().split('//# sourceMappingURL=')[0] == upstream_js, 'Runtime schema code changed during compilation'
    for suffix in ['js', 'js.map', 'd.ts', 'd.ts.map']:
        path = f'dist/sandbox/sandbox-config.{suffix}'
        files[path] = ((temporary / path).read_bytes(), original[path][1])
    files['src/sandbox/sandbox-config.ts'] = (schema, 0o644)
    manifest = json.loads(original['package.json'][0])
    for key in ['scripts', 'devDependencies', 'lint-staged']:
        manifest.pop(key, None)
    manifest['version'] = VERSION
    manifest['dependencies'] = {'@pondwader/socks5-server': '1.0.10', '@types/lodash-es': '4.17.12',
                                'commander': '12.1.0', 'lodash-es': '4.18.1', 'shell-quote': '1.11.0', 'zod': '4.6.6'}
    manifest['files'] += ['src/sandbox/sandbox-config.ts', 'source-seal.json']
    manifest['vinciConsumerFork'] = {'upstreamVersion': '0.0.26', 'zodVersion': '4.6.6', 'runtimePolicyChanges': False}
    files['package.json'] = (encoded(manifest), original['package.json'][1])
    inventory = lambda items: {name: {'sha256': digest(data), 'mode': mode} for name, (data, mode) in sorted(items.items())}
    changed = sorted(name for name in original if files[name] != original[name])
    assert changed == ['dist/sandbox/sandbox-config.d.ts', 'dist/sandbox/sandbox-config.d.ts.map', 'dist/sandbox/sandbox-config.js.map', 'package.json'], changed
    seal = encoded({'schemaVersion': 1, 'origin': ORIGIN, 'version': VERSION, 'typescript': '5.9.3',
                    'changedUpstreamFiles': changed, 'addedFiles': ['source-seal.json', 'src/sandbox/sandbox-config.ts'],
                    'upstreamFiles': inventory(original), 'files': inventory(files)})
    files['source-seal.json'] = (seal, 0o644)
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, (data, mode) in sorted(files.items()):
            member = tarfile.TarInfo('package/' + name)
            member.size, member.mode = len(data), mode
            tar.addfile(member, io.BytesIO(data))
    output = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as stream:
        stream.write(tar_buffer.getvalue())
    return {ARCHIVE: output.getvalue(), 'source-seal.json': seal}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--output', type=Path)
    group.add_argument('--check', action='store_true')
    args = parser.parse_args()
    outputs = generate(args.archive)
    for name, data in outputs.items():
        if args.check:
            assert (VENDOR / name).read_bytes() == data, f'Reproduction differs: {name}'
        else:
            args.output.mkdir(parents=True, exist_ok=True)
            with (args.output / name).open('xb') as file:
                file.write(data)
        print(name, len(data), 'SHA256', digest(data))
