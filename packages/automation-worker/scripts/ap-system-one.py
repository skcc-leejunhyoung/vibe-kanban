#!/usr/bin/env python3
"""Opt-in entrypoint: keep the installed ap gate, replacing quiet periodic delegations."""
import argparse
import datetime as dt
import contextlib
import hashlib
import io
import json
import os
import re
import runpy
import sys
import tempfile


def rows(value):
    return list(value.values()) if isinstance(value, dict) else value if isinstance(value, list) else []


def registry(ap, config):
    schedule = ap['load'](ap['SCHED'], None)
    board = ap['load'](ap['BOARD'], None)
    dispatch = ap['load'](ap['DISPATCH'], None)
    if not all(isinstance(value, dict) for value in (schedule, board, dispatch)):
        raise ValueError('registry unavailable')
    refs = list(config.get('tracked', []))
    entries = [{**row, 'pr': row.get('pr', key)} for key, row in board.get('rows', {}).items()] + rows(dispatch.get('requests', {}))
    for key in ap['PENDING_KEYS']:
        entries += rows(schedule.get(key, []))
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get('pr'):
            continue
        repo = entry.get('repo') or entry.get('repository') or config.get('defaultRepository')
        refs.append({'repository': repo, 'number': int(str(entry['pr']).lstrip('#'))})
    for url in (schedule.get('tracked_reconcile_checkpoint', {}).get('heads', {})):
        match = re.fullmatch(r'https://github\.com/([^/]+/[^/]+)/pull/(\d+)', url)
        if not match:
            raise ValueError('unrecognized tracked PR')
        refs.append({'repository': match[1], 'number': int(match[2])})
    # Scheduling, cancellation and hold records are inputs, never rewritten here.
    stable = {key: schedule.get(key) for key in ap['PENDING_KEYS']}
    stable.update(board=board, dispatch=dispatch)
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    tracked = sorted({(ref['repository'].lower(), ref['number']) for ref in refs})
    scope = {key: config[key] for key in ('connectorId', 'githubConnectorId', 'projectId', 'reviewTagId', 'hosts')}
    scope.update(tracked=[{'repository': repo, 'number': number} for repo, number in tracked], registryHash=digest)
    tasks = ap['load'](ap['DELEG'], {}).get('tasks', {})
    scope['ignoreWorkspaces'] = sorted({task['ws'] for task in rows(tasks) if task.get('kind') == 'periodic' and task.get('ws')})
    checkpoints = [schedule.get(key, {}) for key, _ in ap['CHECKPOINTS']]
    if all(item.get('status') == 'success' and item.get('by') == ap['CHECKPOINT_BY'] and
           not ap['evidence_problems'](ap['load'](item.get('evidence', ''), None)) for item in checkpoints):
        timestamps = [ap['parse'](schedule.get(key, {}).get(field)) for key, field in ap['CHECKPOINTS']]
        if all(timestamps):
            # A newly written checkpoint cannot make an older evidence file fresh.
            timestamps += [dt.datetime.fromtimestamp(os.path.getmtime(item['evidence']), dt.timezone.utc) for item in checkpoints]
            scope['acknowledgedAt'] = min(timestamps).isoformat()
    return scope


def install(ap, config):
    original = ap['periodic_gate']

    def periodic(due, dry=False):
        rest, decision = original(due, dry=True)
        if dry or not decision or decision.get('status') != 'would_delegate':
            return original(due, dry=dry)
        tasks = rows(ap['load'](ap['DELEG'], {}).get('tasks', {}))
        inbox = ap['load'](ap['INBOX'], {}).get('items', {})
        # A manual periodic delegation retains the same admission guard as ap.
        if any(task.get('kind') != 'periodic' and '30분' in task.get('title', '') and
               not task.get('archived') and inbox.get('delegate:' + task['id'], {}).get('status') in ('wait', 'open') for task in tasks):
            return original(due, dry=False)
        try:
            scope = registry(ap, config)
            report = ap['api']('/api/automation/autopilot/reconcile', scope, timeout=110)
            counts = report.get('counts', {}) if isinstance(report, dict) else {}
            if (not isinstance(report, dict) or report.get('status') != 'ok' or report.get('changed') is not False or report.get('errors') != [] or
                not re.fullmatch(r'[0-9a-f]{64}', report.get('fingerprint', '')) or
                any(type(counts.get(key)) is not int or counts[key] < 0 for key in ('issues', 'prs', 'hosts')) or
                counts.get('hosts') != len(set(scope['hosts']))):
                return original(due, dry=False)
            folder = config.get('evidenceDirectory') or os.path.join(ap['AP'], 'system-one-evidence')
            os.makedirs(folder, mode=0o700, exist_ok=True)
            handle, path = tempfile.mkstemp(prefix='reconcile-', suffix='.json', dir=folder)
            with os.fdopen(handle, 'w') as stream:
                json.dump(report, stream)
            with contextlib.redirect_stdout(io.StringIO()):
                result = ap['cmd_checkpoint'](argparse.Namespace(evidence=path))
            if result != 0:
                return original(due, dry=False)
            return rest, {'status': 'handled', 'source': 'code', 'evidence': path, 'counts': report['counts']}
        except Exception:
            # No transcript or credential is included in the fallback result.
            return original(due, dry=False)

    original.__globals__['periodic_gate'] = periodic


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ap', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    with open(args.config) as stream:
        config = json.load(stream)
    namespace = runpy.run_path(os.path.abspath(args.ap), run_name='ap_system_one')
    ap = namespace['periodic_gate'].__globals__
    if config.get('enabled') is True:
        install(ap, config)
    sys.argv = [args.ap, *args.arguments]
    return ap['main']()


if __name__ == '__main__':
    sys.exit(main())
