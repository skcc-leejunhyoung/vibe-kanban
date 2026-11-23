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

PR_URL = re.compile(r'https://github\.com/([^/]+/[^/]+)/pull/(\d+)')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
AGENT_AUDIT_INTERVAL = dt.timedelta(hours=2)


def rows(value):
    return list(value.values()) if isinstance(value, dict) else value if isinstance(value, list) else []


def semantic_registry(value):
    if isinstance(value, dict):
        return {key: semantic_registry(item) for key, item in value.items()
                if key not in ('updated_at', 'checked_at', 'last_checked_at', 'observed_at', 'seen_at')}
    if isinstance(value, list):
        return [semantic_registry(item) for item in value]
    return value


def registry(ap, config):
    schedule = ap['load'](ap['SCHED'], None)
    board = ap['load'](ap['BOARD'], None)
    dispatch = ap['load'](ap['DISPATCH'], None)
    if not all(isinstance(value, dict) for value in (schedule, board, dispatch)):
        raise ValueError('registry unavailable')
    tasks = ap['load'](ap['DELEG'], {}).get('tasks', {})
    periodic = [task for task in rows(tasks) if task.get('kind') == 'periodic']
    periodic_sessions = {task.get('session') for task in periodic if task.get('session')}
    periodic_keys = {'delegate:' + key for key, task in tasks.items() if task.get('kind') == 'periodic'}
    requests = {key: item for key, item in dispatch.get('requests', {}).items()
                if item.get('pr') and key not in periodic_keys and item.get('session') not in periodic_sessions}
    refs = list(config.get('tracked', []))
    board_entries = [{**row, 'pr': row.get('pr', key)} for key, row in board.get('rows', {}).items()]
    entries = board_entries + rows(requests)
    for key in ap['PENDING_KEYS']:
        entries += rows(schedule.get(key, []))
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get('pr'):
            continue
        repo = entry.get('repo') or entry.get('repository') or config.get('defaultRepository')
        refs.append({'repository': repo, 'number': int(str(entry['pr']).lstrip('#'))})
    for url in (schedule.get('tracked_reconcile_checkpoint', {}).get('heads', {})):
        match = PR_URL.fullmatch(url)
        if not match:
            raise ValueError('unrecognized tracked PR')
        refs.append({'repository': match[1], 'number': int(match[2])})
    # Scheduling, cancellation and hold records are inputs, never rewritten here.
    stable = {key: schedule.get(key) for key in ap['PENDING_KEYS']}
    # Rendering and this periodic job's own dispatch cannot trigger the next job.
    stable.update(board={'rows': board.get('rows', {}), 'needs': board.get('needs', [])}, dispatch=requests)
    digest = hashlib.sha256(json.dumps(semantic_registry(stable), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    tracked = sorted({(ref['repository'].lower(), ref['number']) for ref in refs})
    scope = {key: config[key] for key in ('connectorId', 'githubConnectorId', 'hosts')}
    # Tracked PRs outside review discovery (another repository, an old name
    # GitHub redirects) are read by the worker but never discovered there.
    if config.get('readRepositories'):
        scope['readRepositories'] = sorted({repo.lower() for repo in config['readRepositories']})
    if 'projects' in config:
        scope['projects'] = config['projects']
    else:
        scope.update(projectId=config['projectId'], reviewTagId=config['reviewTagId'])
    scope.update(tracked=[{'repository': repo, 'number': number} for repo, number in tracked], registryHash=digest)
    scope['boardPrs'] = sorted({
        '%s#%d' % ((entry.get('repo') or entry.get('repository') or config['defaultRepository']).lower(),
                    int(str(entry['pr']).lstrip('#')))
        for entry in board_entries if entry.get('pr')
    })
    if config.get('boardNoteId'):
        scope['boardNoteId'] = config['boardNoteId']
    scope['ignoreWorkspaces'] = sorted({task['ws'] for task in rows(tasks) if task.get('kind') == 'periodic' and task.get('ws')})
    # Host facts cover only the review sessions this registry tracks; other
    # workspaces change with the user's own work.
    sessions = {row.get('session') for row in rows(requests)}
    reviews = ap['load'](os.path.join(ap['AP'], 'pr-reviews.json'), {})
    sessions |= {row.get('session_id') for row in rows(reviews.get('reviews') if isinstance(reviews, dict) else None)
                 if isinstance(row, dict)}
    for key in ap['PENDING_KEYS']:
        sessions |= {row.get('session_id') for row in rows(schedule.get(key, [])) if isinstance(row, dict)}
    scope['watchSessions'] = sorted(str(s).lower() for s in sessions if isinstance(s, str) and UUID.fullmatch(s))
    return scope


def checkpoint_proof(ap):
    schedule = ap['load'](ap['SCHED'], {})
    checkpoints = [(schedule.get(key, {}), field) for key, field in ap['CHECKPOINTS']]
    if not checkpoints or not all(row.get('status') == 'success' and row.get('by') == ap['CHECKPOINT_BY'] and not row.get('errors') for row, _ in checkpoints):
        return None
    paths = {row.get('evidence') for row, _ in checkpoints}
    if len(paths) != 1 or not (path := paths.pop()):
        return None
    evidence = ap['load'](path, None)
    timestamps = [ap['parse'](row.get(field)) for row, field in checkpoints]
    if not all(timestamps) or ap['evidence_problems'](evidence):
        return None
    # Re-recording an old file does not make its evidence fresh.
    written = dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc)
    return evidence, min(*timestamps, written)


def project_pairs(projects):
    if not isinstance(projects, list) or not projects or not all(isinstance(row, dict) and
            all(isinstance(row.get(key), str) and row[key] for key in ('projectId', 'reviewTagId')) for row in projects):
        return None
    pairs = {(row['projectId'], row['reviewTagId']) for row in projects}
    return pairs if len({pair[0] for pair in pairs}) == len(projects) else None


def matches_coverage(scope, coverage):
    if not isinstance(coverage, dict) or set(coverage) != {'projects', 'hosts', 'repositories'}:
        return False
    for key in ('hosts', 'repositories'):
        values = coverage[key]
        if not isinstance(values, list) or not values or not all(isinstance(item, str) and item for item in values) or len(set(values)) != len(values):
            return False
    expected_projects = project_pairs(scope.get('projects', [scope]))
    return (expected_projects is not None and project_pairs(coverage['projects']) == expected_projects and
            set(coverage['hosts']) == set(scope['hosts']) and
            all(ref['repository'] in coverage['repositories'] or ref['repository'] in scope.get('readRepositories', [])
                for ref in scope['tracked']))


def identity_recheck_due(ap, reviewed_at):
    schedule = ap['load'](ap['SCHED'], {})
    now = ap['now']()
    for key in ap['PENDING_KEYS']:
        for row in rows(schedule.get(key)):
            if not isinstance(row, dict) or row.get('status') != 'needs_identity' or not row.get('next_check_at'):
                continue
            due = ap['parse'](row['next_check_at'])
            if not due or reviewed_at < due <= now:
                return True
    return False


def install(ap, config):
    original = ap['periodic_gate']

    def manual_delegation_open():
        tasks = rows(ap['load'](ap['DELEG'], {}).get('tasks', {}))
        inbox = ap['load'](ap['INBOX'], {}).get('items', {})
        # A manual periodic delegation retains the same admission guard as ap.
        return any(task.get('kind') != 'periodic' and '30분' in task.get('title', '') and
                   not task.get('archived') and inbox.get('delegate:' + task['id'], {}).get('status') in ('wait', 'open') for task in tasks)

    def quiet_checkpoint(due):
        if manual_delegation_open():
            return None, 'existing_delegation'
        scope = registry(ap, config)
        proof = checkpoint_proof(ap)
        if proof is None:
            return None, 'missing_scope_proof'
        evidence, acknowledged = proof
        coverage = evidence.get('coverage')
        if (not matches_coverage(scope, coverage) or
            any(section.get('projects', len(coverage['projects'])) != len(coverage['projects'])
                for section in (evidence.get('counts', {}), evidence.get('discovery_scope', {}))) or
            len(evidence.get('counts', {}).get('workspaces', coverage['hosts'])) != len(coverage['hosts'])):
            return None, 'scope_mismatch'
        reviewed_at = ap['parse'](evidence['agentReviewedAt']) if 'agentReviewedAt' in evidence else acknowledged
        if not reviewed_at or not reviewed_at <= acknowledged <= ap['now']():
            return None, 'invalid_agent_review_time'
        if ap['now']() - reviewed_at >= AGENT_AUDIT_INTERVAL:
            return None, 'scope_audit_due'
        if identity_recheck_due(ap, reviewed_at):
            return None, 'identity_recheck_due'
        request = {**scope, 'acknowledgedAt': reviewed_at.isoformat(),
                   'boardResolutions': [row for row in rows(evidence.get('boardResolutions')) if isinstance(row, dict)]}
        report = ap['api']('/api/automation/autopilot/reconcile', request, timeout=110)
        if not isinstance(report, dict) or report.get('status') != 'ok':
            return None, 'source_unavailable'
        counts = report.get('counts', {})
        if (report.get('errors') != [] or
            not re.fullmatch(r'[0-9a-f]{64}', report.get('fingerprint', '')) or
            any(type(counts.get(key)) is not int or counts[key] < 0 for key in ('issues', 'prs', 'hosts')) or
            counts['hosts'] != len(set(scope['hosts'])) or
            not matches_coverage(scope, report.get('coverage')) or
            set(report['coverage']['repositories']) != set(coverage['repositories']) or
            report.get('registryHash') != scope['registryHash'] or report.get('checkedTracked') != scope['tracked']):
            return None, 'incomplete_coverage'
        folder = config.get('evidenceDirectory') or os.path.join(ap['AP'], 'system-one-evidence')
        board_report = os.path.join(folder, 'board-reconciliation.json')
        pending = report.get('boardPending')
        if not isinstance(pending, list):
            return None, 'unverified_board'
        if pending or os.path.exists(board_report):
            os.makedirs(folder, mode=0o700, exist_ok=True)
            handle, path = tempfile.mkstemp(prefix='board-', suffix='.json', dir=folder)
            with os.fdopen(handle, 'w') as stream:
                json.dump({'checkedAt': report['checkedAt'], 'boardPending': pending}, stream)
            os.replace(path, board_report)
        if pending or report.get('changed') is not False:
            return None, 'facts_changed'
        findings = evidence.get('board_findings')
        if not isinstance(findings, list) or evidence.get('board_mismatches', []) not in ([], 0):
            return None, 'unverified_board'
        if 'board_followups_due' in ap and ap['board_followups_due'](ap['load'](ap['BOARD'], {}), ap['now']()):
            return None, 'board_followup_due'
        aliases = {old.lower(): new.lower() for old, new in (config.get('repositoryAliases') or {}).items()}
        canonical = lambda repo: aliases.get(repo.lower(), repo.lower())
        tracked = {(canonical(pr['repository']), pr['number']) for pr in scope['tracked']}
        for finding in findings:
            match = PR_URL.fullmatch(finding.get('pr_url', ''))
            if not match or (canonical(match[1]), int(match[2])) not in tracked:
                return None, 'unverified_board'
        try:
            ap['verify_board_coverage'](evidence, {})
        except (KeyError, ValueError):
            return None, 'unverified_board'
        rest, decision = original(due, dry=True)
        if (not decision or decision.get('status') != 'would_delegate' or manual_delegation_open() or
            checkpoint_proof(ap) != proof or registry(ap, config) != scope or identity_recheck_due(ap, reviewed_at) or
            ap['now']() - reviewed_at >= AGENT_AUDIT_INTERVAL):
            return None, 'admission_changed'
        report.update(board_findings=findings, board_mismatches=[], board_snapshot_sha=evidence['board_snapshot_sha'],
                      agentReviewedAt=reviewed_at.isoformat())
        os.makedirs(folder, mode=0o700, exist_ok=True)
        handle, path = tempfile.mkstemp(prefix='reconcile-', suffix='.json', dir=folder)
        with os.fdopen(handle, 'w') as stream:
            json.dump(report, stream)
        with contextlib.redirect_stdout(io.StringIO()):
            result = ap['cmd_checkpoint'](argparse.Namespace(evidence=path))
        if result != 0:
            return None, 'checkpoint_rejected'
        return (rest, {'status': 'handled', 'source': 'code', 'evidence': path, 'counts': counts}), None

    def periodic(due, dry=False):
        rest, decision = original(due, dry=True)
        if dry:
            return rest, decision
        if decision and decision.get('status') == 'would_delegate':
            try:
                handled, reason = quiet_checkpoint(due)
            except Exception:
                handled, reason = None, 'reconciliation_unavailable'
            if handled is not None:
                return handled
            rest, result = original(due, dry=False)
            if isinstance(result, dict):
                result = {**result, 'system_one_fallback': reason}
            return rest, result
        return original(due, dry=False)

    original.__globals__['periodic_gate'] = periodic
    if 'periodic_prompt' in ap:
        original_prompt = ap['periodic_prompt']

        projects = config.get('projects') or [{'projectId': config.get('projectId'), 'reviewTagId': config.get('reviewTagId')}]
        expected = json.dumps({'projects': [{'projectId': row['projectId'], 'reviewTagId': row['reviewTagId']} for row in projects],
                               'repositories': config.get('discoveryRepositories') or [config.get('defaultRepository')],
                               'hosts': config['hosts']}, ensure_ascii=False, separators=(',', ':'))

        def periodic_prompt():
            return (original_prompt() +
                    ' System One 검증용으로 공식 증거에 coverage를 기록한다. 이번 대조 범위는 ' + expected + '이다. ' +
                    'projects의 각 프로젝트 review 태그 이슈, repositories의 review 요청 발견, hosts의 각 호스트 공간·실행·queue를 ' +
                    '모두 공식 조회로 확인한 경우에만 이 값을 그대로 coverage로 기록한다. 하나라도 못 했으면 coverage를 넣지 않는다. ' +
                    '증거 디렉터리의 board-reconciliation.json에 대기 항목이 있으면 각 key와 fingerprint를 확인하고, '
                    '게시 검증 시 disposition=published와 rowSha256을, 보류 시 disposition=hold와 reason, owner, recheckAt을 boardResolutions에 기록한다.')

        ap['periodic_prompt'] = periodic_prompt


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
