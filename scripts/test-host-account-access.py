#!/usr/bin/env python3
"""Run account/relay regressions against a private, fully migrated PostgreSQL.

No existing database, container or listening port is stopped or reused.
Use --docker in CI, or install PostgreSQL and set PG_BIN locally.
"""
import argparse
import base64
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker', action='store_true')
    parser.add_argument('--prepare', action='store_true', help='Regenerate both remote SQLx caches before tests')
    parser.add_argument('--command', nargs=argparse.REMAINDER, help='Run a command with the disposable database instead of tests')
    args = parser.parse_args()
    os.chdir(Path(__file__).resolve().parents[1])
    with tempfile.TemporaryDirectory(prefix='vk-host-account-test-') as temp:
        container = None
        pg_ctl = None
        started = False
        try:
            if args.docker:
                container = 'vk-host-account-test-' + uuid.uuid4().hex
                run('docker', 'run', '--detach', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                    '-e', 'POSTGRES_DB=remote', '-p', '127.0.0.1::5432', 'postgres:14')
                port = subprocess.check_output(['docker', 'port', container, '5432/tcp'], text=True).strip().rsplit(':', 1)[1]
                for _ in range(60):
                    if subprocess.run(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                        break
                    time.sleep(0.5)
                else:
                    raise RuntimeError('Disposable PostgreSQL did not start')
            else:
                pg_bin = os.environ.get('PG_BIN')
                if not pg_bin:
                    installed = shutil.which('pg_config')
                    if installed:
                        pg_bin = subprocess.check_output([installed, '--bindir'], text=True).strip()
                    else:
                        pg_bin = '/opt/homebrew/opt/postgresql@14/bin'
                pg_ctl = str(Path(pg_bin) / 'pg_ctl')
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = str(sock.getsockname()[1])
                run(str(Path(pg_bin) / 'initdb'), '-D', temp + '/data', '-U', 'postgres', '-A', 'trust', '--no-locale', stdout=subprocess.DEVNULL)
                run(pg_ctl, '-D', temp + '/data', '-l', temp + '/postgres.log', '-o', f'-h 127.0.0.1 -p {port} -k {temp}', '-w', 'start')
                started = True
                run(str(Path(pg_bin) / 'createdb'), '-h', '127.0.0.1', '-p', port, '-U', 'postgres', 'remote')
            url = f'postgres://postgres@127.0.0.1:{port}/remote'
            env = dict(os.environ, DATABASE_URL=url, HOST_ACCESS_TEST_DATABASE_URL=url, OAUTH_TEST_DATABASE_URL=url, HOST_GRANT_ISSUER=url.replace("postgres://postgres@", "http://").removesuffix("/remote"), HOST_GRANT_KEY_ID="test-key", RELAY_PREVIEW_HOST_SUFFIX="preview.example.test", HOST_GRANT_SIGNING_KEY=base64.b64encode(os.urandom(32)).decode())
            run('cargo', 'sqlx', 'migrate', 'run', '--source', 'crates/remote/migrations', '--database-url', url, env=env)
            if args.prepare:
                prepare_env = dict(env, SQLX_OFFLINE='false')
                for crate in ['remote', 'relay-tunnel']:
                    run('cargo', 'sqlx', 'prepare', '--', '--all-targets', cwd=f'crates/{crate}', env=prepare_env)
            if args.command:
                run(*args.command, env=env)
            else:
                env['SQLX_OFFLINE'] = 'true'
                run('cargo', 'test', '--manifest-path', 'crates/remote/Cargo.toml', '--lib', 'host_access_tests', '--', '--ignored', env=env)
                run('cargo', 'test', '--manifest-path', 'crates/relay-tunnel/Cargo.toml', 'host_access_tests', '--', '--ignored', env=env)
                run('cargo', 'test', '--manifest-path', 'crates/remote/Cargo.toml', '--lib', 'auth::handoff', '--', '--ignored', env=env)
        finally:
            if container:
                run('docker', 'rm', '--force', container, stdout=subprocess.DEVNULL)
            if started:
                run(pg_ctl, '-D', temp + '/data', '-m', 'fast', '-w', 'stop')


if __name__ == '__main__':
    main()
