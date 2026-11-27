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
import shlex
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

PR_URL = re.compile(r'https://github\.com/([^/]+/[^/]+)/pull/(\d+)')
BOARD_ROW = re.compile(r'^\|\s*\[[^\]]+\]\((' + PR_URL.pattern + r')\)\s*\|')
SHA256 = re.compile(r'[0-9a-f]{64}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
AGENT_AUDIT_INTERVAL = dt.timedelta(hours=2)
PARTIAL_MAX_AGE = dt.timedelta(minutes=30)
READ_REPOSITORY_LIMIT = 16   # the worker's cap on read-only repositories


def rows(value):
    return list(value.values()) if isinstance(value, dict) else value if isinstance(value, list) else []


def semantic_registry(value):
    if isinstance(value, dict):
        return {key: semantic_registry(item) for key, item in value.items()
                if key not in ('updated_at', 'checked_at', 'last_checked_at', 'observed_at', 'seen_at')}
    if isinstance(value, list):
        return [semantic_registry(item) for item in value]
    return value


def registry_index(stable, config):
    by_pr, unscoped = {}, []
    for group, entries in stable.items():
        if isinstance(entries, dict):
            items = entries.items()
        elif isinstance(entries, list):
            items = enumerate(entries)
        else:
            unscoped.append((group, entries))
            continue
        for key, row in items:
            default_pr = key if group == 'board_rows' else None
            pr = row.get('pr', default_pr) if isinstance(row, dict) else None
            repo = (row.get('repo') or row.get('repository') or config.get('defaultRepository')) if pr else None
            if not repo or not re.fullmatch(r'#[1-9]\d*|[1-9]\d*', str(pr)):
                unscoped.append((group, key, row))
                continue
            ref = f'{repo.lower()}#{str(pr).lstrip("#")}'
            by_pr.setdefault(ref, []).append((group, key, row))
    def digest(value):
        return hashlib.sha256(json.dumps(semantic_registry(value), sort_keys=True).encode()).hexdigest()
    return {'byPr': {key: digest(items) for key, items in by_pr.items()}, 'unscoped': digest(unscoped)}


def registry(ap, config, *, schedule=None):
    if schedule is None:
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
    checked = set()   # repositories of PRs the periodic agent itself recorded as reconciled
    for url in (schedule.get('tracked_reconcile_checkpoint', {}).get('heads', {})):
        match = PR_URL.fullmatch(url)
        if not match:
            raise ValueError('unrecognized tracked PR')
        refs.append({'repository': match[1], 'number': int(match[2])})
        checked.add(match[1].lower())
    # Scheduling, cancellation and hold records are inputs, never rewritten here.
    stable = {key: schedule.get(key) for key in ap['PENDING_KEYS']}
    # Rendering and this periodic job's own dispatch cannot trigger the next job.
    stable.update(board={'rows': board.get('rows', {}), 'needs': board.get('needs', [])},
                  dispatch={key: {k: v for k, v in row.items()
                                  if k != 'reconcile_checks' or row.get('status') not in ('sending', 'uncertain')}
                            for key, row in requests.items()})
    digest = hashlib.sha256(json.dumps(semantic_registry(stable), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    tracked = sorted({(ref['repository'].lower(), ref['number']) for ref in refs})
    scope = {key: config[key] for key in ('connectorId', 'githubConnectorId', 'hosts')}
    # Tracked PRs outside review discovery (another repository, an old name
    # GitHub redirects) are read by the worker but never discovered there.
    # Declared repositories, plus those whose PRs the agent's own checkpoint
    # recorded, up to the worker's limit (beyond it the scope stays unproven).
    discovery = {repo.lower() for repo in config.get('discoveryRepositories') or [config.get('defaultRepository')] if repo}
    declared = {repo.lower() for repo in config.get('readRepositories') or []}
    readable = declared | (checked - discovery)
    if len(readable) > READ_REPOSITORY_LIMIT:
        readable = declared
    if readable:
        scope['readRepositories'] = sorted(readable)
    if 'projects' in config:
        scope['projects'] = config['projects']
    else:
        scope.update(projectId=config['projectId'], reviewTagId=config['reviewTagId'])
    scope.update(tracked=[{'repository': repo, 'number': number} for repo, number in tracked], registryHash=digest)
    scope['registryIndex'] = registry_index({**{key: value for key, value in stable.items() if key != 'board'},
                                            'board_rows': stable['board']['rows'],
                                            'board_needs': stable['board']['needs']}, config)
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


def checkpoint_counts_match(evidence, coverage):
    project_count = len(coverage['projects'])
    for field in ('counts', 'discovery_scope'):
        section = evidence.get(field, {})
        if not isinstance(section, dict):
            return False
        projects = section.get('projects', project_count)
        if isinstance(projects, list):
            # Some agent evidence reports an issue count per project.
            if any(type(count) is not int or count < 0 for count in projects):
                return False
            projects = len(projects)
        if type(projects) is not int or projects != project_count:
            return False
    workspaces = evidence.get('counts', {}).get('workspaces', coverage['hosts'])
    return isinstance(workspaces, (list, dict)) and len(workspaces) == len(coverage['hosts'])


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


def write_evidence(folder, prefix, evidence):
    os.makedirs(folder, mode=0o700, exist_ok=True)
    handle, path = tempfile.mkstemp(prefix=prefix, suffix='.json', dir=folder)
    with os.fdopen(handle, 'w') as stream:
        json.dump(evidence, stream)
    return path


def evidence_folder(ap, config):
    return config.get('evidenceDirectory') or os.path.join(ap['AP'], 'system-one-evidence')


def proof_version(proof):
    evidence, at = proof
    return hashlib.sha256(json.dumps([evidence, at.isoformat()], sort_keys=True).encode()).hexdigest()


def pr_key(url):
    match = PR_URL.fullmatch(str(url or ''))
    return f'{match[1].lower()}#{int(match[2])}' if match else None


def board_versions(board):
    if not isinstance(board.get('body'), str):
        return None
    section = ''
    versions, context = {}, []
    for line in board['body'].strip().splitlines():
        if line.startswith('## '):
            section = line
        match = BOARD_ROW.match(line)
        if match:
            key = pr_key(match[1])
            if key in versions:
                raise ValueError('게시 보드의 PR 행이 중복됨')
            versions[key] = hashlib.sha256((section + '\n' + line).encode()).hexdigest()
        elif line != '| — | 없음 | — |':
            context.append(line)
    if set(versions) != {pr_key(url) for url in board['pr_urls']}:
        raise ValueError('게시 보드의 PR 행 범위가 일치하지 않음')
    return {'sha': board['sha'], 'context': hashlib.sha256('\n'.join(context).encode()).hexdigest(), 'rows': versions}


def partial_input(ap, scope, proof, reviewed_at, report):
    changes = report.get('changes')
    if not isinstance(changes, dict):
        return None, 'missing_change_baseline'
    if any(changes.get(key) is not False for key in ('scopeChanged', 'registryChanged')):
        return None, 'unverified_change_scope'
    checks = changes.get('checks')
    if not isinstance(checks, list) or len(checks) > 50 or len(report['boardPending']) > 50:
        return None, 'unverified_change_size'
    if 'board_snapshot' not in ap or 'periodic_active' not in ap:
        return None, 'missing_checkpoint_tools'
    previous = proof[0]
    if (previous.get('fingerprint') != changes['baseFingerprint'] and
            (previous.get('fingerprint') or ap['parse'](changes.get('baseAcknowledgedAt')) != reviewed_at)):
        return None, 'unbound_checkpoint'
    try:
        board = ap['board_snapshot']()
        current_board = board_versions(board)
    except (KeyError, ValueError):
        return None, 'unverified_board'
    checks = list(checks)
    if board['sha'] != previous.get('board_snapshot_sha'):
        old_board = previous.get('boardVersions')
        if not current_board or not isinstance(old_board, dict) or old_board.get('sha') != previous.get('board_snapshot_sha'):
            return None, 'missing_board_versions'
        if old_board.get('context') != current_board['context']:
            return None, 'board_context_changed'
        old_rows, new_rows = old_board.get('rows'), current_board['rows']
        if not isinstance(old_rows, dict) or set(old_rows) != {
                pr_key(row['pr_url']) for row in previous.get('board_findings', []) if row.get('checked') is True}:
            return None, 'unverified_board'
        for key in sorted(old_rows.keys() | new_rows.keys()):
            before, after = old_rows.get(key), new_rows.get(key)
            if before == after:
                continue
            version = hashlib.sha256(json.dumps(['board-row', key, before, after]).encode()).hexdigest()
            checks.append({'kind': 'board', 'key': key, 'before': before, 'after': after, 'version': version})
    if not 0 < len(checks) <= 50:
        return None, 'unverified_change_size'
    pr_facts = changes['prFacts']
    targets = {row['key'] for row in report['boardPending']}
    for check in checks:
        if check['kind'] in ('registry', 'board'):
            targets.add(check['key'])
        for value in (check.get('before'), check.get('after')):
            if value and check['kind'] == 'pr':
                targets.update([value['key'], *value['aliases']])
            if value and check['kind'] == 'issue':
                targets.update(pr_key(url) for url in value['prs'])
    # Unchanged rows inherit their verified head; changed rows are in the plan.
    old_heads = {pr_key(row['pr_url']): row['head'] for row in previous.get('board_findings', [])
                 if row.get('checked') is True}
    findings = []
    for url in board['pr_urls']:
        key = pr_key(url)
        head = changes['boardHeads'].get(key)
        if not head or (key not in targets and old_heads.get(key) != head):
            return None, 'unverified_board_head'
        findings.append({'pr_url': url, 'head': head, 'checked': True})
    versions = [row['version'] for row in checks]
    if len(set(versions)) != len(versions) or any(not isinstance(value, str) or not SHA256.fullmatch(value) for value in versions):
        return None, 'invalid_change_versions'
    return {'proof': proof_version(proof), 'scope': scope, 'fingerprint': report['fingerprint'],
            'baseFingerprint': changes['baseFingerprint'], 'checkedAt': report['checkedAt'],
            'agentReviewedAt': reviewed_at.isoformat(), 'coverage': report['coverage'], 'counts': report['counts'],
            'checks': checks, 'prFacts': {key: row for key, row in pr_facts.items() if key in targets},
            'boardPending': report['boardPending'], 'board_snapshot_sha': board['sha'], 'board_findings': findings,
            'boardVersions': current_board,
            'board_mismatches': [row for row in previous.get('board_mismatches', []) if pr_key(row['pr_url']) not in targets],
            'boardResolutions': [row for row in previous.get('boardResolutions', []) if row['key'] not in targets]}, None


def execution_prompt(row):
    action = row.get('executor_action')
    request = action.get('typ') if isinstance(action, dict) else None
    if not isinstance(request, dict):
        return ''
    prompt = request.get('handoff_user_prompt') or request.get('prompt')
    return prompt.strip() if isinstance(prompt, str) else ''


def is_checkpoint_recovery(ap, task, execution):
    host_args = ap.get('HOSTS', {}).get(task.get('host'))
    if host_args is None or 'vk' not in ap or 'autopilot_stop' not in ap:
        return False
    history = ap['vk']('session', 'executions', task['session'], *host_args)
    if not isinstance(history, list) or any(not isinstance(row, dict) for row in history):
        return False
    chain = [(ap['parse'](row.get('created_at') or row.get('started_at')), row) for row in history
             if row.get('session_id') == task['session'] and row.get('run_reason') == 'codingagent' and not row.get('dropped')]
    if any(stamp is None for stamp, _ in chain):
        return False
    chain.sort(key=lambda item: item[0])
    previous = None
    original_prompt = ''
    needs_resume = False
    resume_line = f"정기 대조 재개 {task['id']}"
    for stamp, row in chain:
        if previous is None:
            if row.get('id') == task['exec']:
                previous = (stamp, row)
                original_prompt = execution_prompt(row)
            continue
        prior_stamp, prior = previous
        ended = ap['parse'](prior.get('completed_at'))
        status = prior.get('status')
        if status not in ('failed', 'killed') or stamp <= prior_stamp or (ended and stamp < ended):
            return False
        if status == 'killed' and not ap['autopilot_stop'](prior['id']):
            needs_resume = True
        if needs_resume:
            # An explicit replay or resume can follow earlier failed retries.
            prompt = execution_prompt(row)
            if prompt and (prompt == original_prompt or prompt.partition('\n')[0].rstrip() == resume_line):
                needs_resume = False
        if row.get('id') == execution:
            return not needs_resume and row.get('status') == 'running'
        previous = (stamp, row)
    return False


def verify_checkpoint_execution(ap, plan):
    binding = plan['task']
    execution = os.environ.get('VK_EXECUTION_ID')
    if not execution or os.environ.get('VK_SESSION_ID') != binding['session']:
        raise ValueError('대조 위임 실행이 일치하지 않음')
    active = ap['periodic_active']()
    resume = ap.get('resumed_after_cancel')
    task = active or (resume() if resume else None) or {}
    if (task.get('id') != binding['id'] or task.get('session') != binding['session'] or
            not task.get('exec') or
            (binding.get('exec') and binding['exec'] != task['exec'])):
        raise ValueError('대조 위임 실행이 일치하지 않음')
    if (not active or task['exec'] != execution) and not is_checkpoint_recovery(ap, task, execution):
        raise ValueError('대조 위임 실행이 일치하지 않음')
    return task


def write_checkpoint(ap, config, prefix, evidence, task):
    path = write_evidence(evidence_folder(ap, config), prefix, evidence)
    if task is None:
        return ap['cmd_checkpoint'](argparse.Namespace(evidence=path))
    active = ap['periodic_active']

    def verified_task():
        current = active()
        if current is None and ap.get('resumed_after_cancel'):
            current = ap['resumed_after_cancel']()
        if current != task:
            raise ValueError('체크포인트 작성 전 대조 위임이 바뀜')
        return current

    # The official writer uses the task to enforce board coverage and record its proof.
    ap['periodic_active'] = verified_task
    try:
        return ap['cmd_checkpoint'](argparse.Namespace(evidence=path))
    finally:
        ap['periodic_active'] = active


def checkpoint_full(ap, config, result_path, plan=None, *, board_only=False):
    task = verify_checkpoint_execution(ap, plan) if plan is not None else None
    active = task if task is not None else ap['periodic_active']()
    since = ap['parse']((active or {}).get('at')) or ap['now']() - AGENT_AUDIT_INTERVAL
    with open(result_path) as stream:
        written = dt.datetime.fromtimestamp(os.fstat(stream.fileno()).st_mtime, dt.timezone.utc)
        if written < since:
            raise ValueError('이번 대조 이전의 전체 대조 증거')
        result = json.load(stream)
    if ap['evidence_problems'](result):
        raise ValueError('전체 대조 증거가 완전하지 않음')
    board = ap['board_snapshot']()
    if board['sha'] != result.get('board_snapshot_sha'):
        raise ValueError('전체 대조 중 게시 보드 버전이 바뀜')
    evidence = {key: value for key, value in result.items()
                if key not in ('fingerprint', 'acknowledgedFingerprint', 'boardVersions')}
    evidence['boardVersions'] = board_versions(board)
    if board_only:
        if plan is None or plan.get('factsUnchanged') is not True:
            raise ValueError('보드 전용 대조의 작업기 증거가 없음')
        evidence.update(fingerprint=plan['fingerprint'], coverage=plan['coverage'], counts=plan['counts'],
                        agentReviewedAt=plan['agentReviewedAt'])
    elif plan is not None:
        checked = ap['parse'](plan['checkedAt'])
        audit = plan['auditSnapshot']
        observed = {key: pr for pr in audit['prs']['facts'] for key in [pr['key'], *pr['aliases']]}
        schedule = ap['load'](ap['SCHED'], {})
        scope = registry(ap, config, schedule=schedule)
        recorded_heads = schedule.get('tracked_reconcile_checkpoint', {}).get('heads', {})
        recorded_prs_match = isinstance(recorded_heads, dict)
        if recorded_prs_match:
            for url, record in recorded_heads.items():
                pr = observed.get(pr_key(url), {})
                # An older worker can prove OPEN but didn't distinguish CLOSED from MERGED.
                state = pr.get('githubState', 'OPEN' if pr.get('state') == 'open' else None)
                if (not isinstance(record, dict) or not isinstance(record.get('headRefOid'), str) or
                        pr.get('head') != record['headRefOid'].lower() or
                        state not in ('OPEN', 'CLOSED', 'MERGED') or record.get('state') != state):
                    recorded_prs_match = False
                    break
        same_inputs = all(scope.get(key) == value for key, value in plan['scope'].items()
                          if key not in ('ignoreWorkspaces', 'tracked'))
        observed_tracked = all(f"{pr['repository']}#{pr['number']}" in observed for pr in scope['tracked'])
        coverage = result.get('coverage')
        if (same_inputs and observed_tracked and recorded_prs_match and checked and
                dt.timedelta() <= ap['now']() - checked < PARTIAL_MAX_AGE and
                matches_coverage(scope, coverage) and set(coverage['repositories']) == set(plan['coverage']['repositories']) and
                result.get('auditReviewed') == {key: group['version'] for key, group in audit.items()} and
                all(observed.get(pr_key(row['pr_url']), {}).get('head') == row['head'] for row in result['board_findings'])):
            evidence.update(fingerprint=plan['fingerprint'], acknowledgedFingerprint=plan['fingerprint'])
    return write_checkpoint(ap, config, 'reconcile-board-' if board_only else 'reconcile-full-', evidence, task)


def checkpoint_partial(ap, config, input_path, result_path):
    with open(input_path) as stream:
        plan = json.load(stream)
    with open(result_path) as stream:
        result = json.load(stream)
    now = ap['now']()
    checked = ap['parse'](plan['checkedAt'])
    task = verify_checkpoint_execution(ap, plan)
    if checked is None or not dt.timedelta() <= now - checked < PARTIAL_MAX_AGE:
        raise ValueError('부분 대조 스냅샷 기한 만료')
    proof = checkpoint_proof(ap)
    current_scope = registry(ap, config)
    if proof is None or proof_version(proof) != plan['proof'] or any(
            current_scope.get(key) != value for key, value in plan['scope'].items() if key != 'ignoreWorkspaces'):
        raise ValueError('부분 대조 중 공식 체크포인트 또는 장부 변경')
    if (ap['evidence_problems'](result) or type(result.get('changed')) is not bool or
            result.get('fingerprint') != plan['fingerprint'] or
            sorted(result.get('checked', [])) != sorted(row['version'] for row in plan['checks'])):
        raise ValueError('부분 대조 증거의 버전 또는 범위 불일치')
    targets = {key: row['head'] for key, row in plan['prFacts'].items()}
    for name in ('board_mismatches', 'autopilot_actions'):
        if not isinstance(result.get(name), list) or any(
                targets.get(pr_key(row['pr_url'])) != row['head'] or not row['head'] for row in result[name]):
            raise ValueError('부분 대조 결과에 범위 밖 PR 또는 다른 head가 포함됨')
    if not isinstance(result.get('boardResolutions'), list):
        raise ValueError('보드 대조 증거 누락')
    pending = {row['key']: row['fingerprint'] for row in plan['boardPending']}
    if any(pending.get(row['key']) != row['fingerprint'] or not row['fingerprint']
           for row in result['boardResolutions']):
        raise ValueError('부분 대조 보드 버전 불일치')
    evidence = {**result, 'coverage': plan['coverage'], 'counts': plan['counts'],
                'agentReviewedAt': plan['agentReviewedAt'], 'acknowledgedFingerprint': plan['fingerprint'],
                'board_snapshot_sha': plan['board_snapshot_sha'], 'board_findings': plan['board_findings'],
                'boardVersions': plan.get('boardVersions'),
                'board_mismatches': plan['board_mismatches'] + result['board_mismatches'],
                'boardResolutions': plan['boardResolutions'] + result['boardResolutions']}
    ap['verify_board_coverage'](evidence, {})
    return write_checkpoint(ap, config, 'reconcile-partial-', evidence, task)


def install(ap, config, entrypoint=None):
    original = ap['periodic_gate']
    board_only_evidence = None
    partial_evidence = None
    full_plan = full_evidence = None

    def can_bind_checkpoint():
        return entrypoint and 'board_snapshot' in ap and 'periodic_active' in ap

    def manual_delegation_open():
        tasks = rows(ap['load'](ap['DELEG'], {}).get('tasks', {}))
        inbox = ap['load'](ap['INBOX'], {}).get('items', {})
        # A manual periodic delegation retains the same admission guard as ap.
        return any(task.get('kind') != 'periodic' and '30분' in task.get('title', '') and
                   not task.get('archived') and inbox.get('delegate:' + task['id'], {}).get('status') in ('wait', 'open') for task in tasks)

    def admission_current(due, proof, scope, reviewed_at):
        rest, decision = original(due, dry=True)
        return rest, bool(decision and decision.get('status') == 'would_delegate' and
                          not manual_delegation_open() and checkpoint_proof(ap) == proof and
                          registry(ap, config) == scope and not identity_recheck_due(ap, reviewed_at) and
                          ap['now']() - reviewed_at < AGENT_AUDIT_INTERVAL)

    budget_key = 'reconciliation_github_budget'

    def budget_deferred(report):
        return {'status': 'deferred', 'source': 'code', 'reason': report.get('reason'),
                'remaining': report.get('remaining'),
                **({'retryAt': report['retryAt']} if report.get('retryAt') else {})}

    def partial_route(due, scope, proof, reviewed_at, report):
        nonlocal partial_evidence
        if not entrypoint or 'periodic_prompt' not in ap:
            return None
        latest = next((row for row in reversed(rows(ap['load'](ap['DELEG'], {}).get('tasks')))
                       if row.get('kind') == 'periodic' and row.get('result')), {})
        if latest.get('result', {}).get('status') == 'error':
            return 'previous_reconciliation_failed'
        plan, reason = partial_input(ap, scope, proof, reviewed_at, report)
        if plan is None:
            return reason
        if not admission_current(due, proof, scope, reviewed_at)[1]:
            return 'admission_changed'
        partial_evidence = write_evidence(evidence_folder(ap, config), 'partial-', plan)
        return 'partial:' + ','.join(sorted({row['kind'] for row in plan['checks']}))

    def quiet_checkpoint(due):
        nonlocal board_only_evidence, full_plan
        if manual_delegation_open():
            return None, 'existing_delegation'
        state_path = ap.get('GATE_STATE')
        cached = ap['load'](state_path, {}).get(budget_key) if state_path else None
        current = ap['now']().timestamp()
        if (isinstance(cached, dict) and cached.get('connector') == config['githubConnectorId']
                and type(cached.get('retryAt')) is int and current < cached['retryAt'] <= current + 3600):
            rest, _ = original(due, dry=True)
            return (rest, budget_deferred(cached)), None
        scope = registry(ap, config)
        proof = checkpoint_proof(ap)
        if proof is None:
            return None, 'missing_scope_proof'
        evidence, acknowledged = proof
        coverage = evidence.get('coverage')
        if not matches_coverage(scope, coverage) or not checkpoint_counts_match(evidence, coverage):
            return None, 'scope_mismatch'
        reviewed_at = ap['parse'](evidence['agentReviewedAt']) if 'agentReviewedAt' in evidence else acknowledged
        if not reviewed_at or not reviewed_at <= acknowledged <= ap['now']():
            return None, 'invalid_agent_review_time'
        audit_due = ap['now']() - reviewed_at >= AGENT_AUDIT_INTERVAL
        if audit_due and not can_bind_checkpoint():
            return None, 'scope_audit_due'
        if not audit_due and identity_recheck_due(ap, reviewed_at):
            return None, 'identity_recheck_due'
        request = {**scope, 'boardAcknowledgedAt': acknowledged.isoformat(),
                   'boardResolutions': [row for row in rows(evidence.get('boardResolutions')) if isinstance(row, dict)]}
        if entrypoint:
            request['includeAuditSnapshot'] = True
        if audit_due:
            request['auditDue'] = True
        if evidence.get('acknowledgedFingerprint'):
            request.update(acknowledgedAt=acknowledged.isoformat(),
                           acknowledgedFingerprint=evidence['acknowledgedFingerprint'])
        report = ap['api']('/api/automation/autopilot/reconcile', request, timeout=110)
        if isinstance(report, dict) and report.get('status') == 'deferred':
            # The GitHub budget is below the reserve; a delegated agent would spend
            # the same account's budget, so this cycle neither checks nor delegates.
            rest, _ = original(due, dry=True)
            retry_at = report.get('retryAt')
            current = ap['now']().timestamp()
            if (state_path and report.get('reason') == 'github_budget_low'
                    and type(retry_at) is int and current < retry_at <= current + 3600):
                state = ap['load'](state_path, {})
                state[budget_key] = {**budget_deferred(report), 'connector': config['githubConnectorId']}
                try:
                    ap['save'](state_path, state)
                except OSError:
                    pass  # A local cache failure must not trigger an agent on the same budget.
            return (rest, budget_deferred(report)), None
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
        folder = evidence_folder(ap, config)
        board_report = os.path.join(folder, 'board-reconciliation.json')
        pending = report.get('boardPending')
        if not isinstance(pending, list):
            return None, 'unverified_board'
        audit_snapshot = report.pop('auditSnapshot', None)
        if isinstance(audit_snapshot, dict) and set(audit_snapshot) == {'prs', 'issues', 'hosts'}:
            full_plan = {'scope': scope, 'fingerprint': report['fingerprint'], 'checkedAt': report['checkedAt'],
                         'coverage': report['coverage'], 'auditSnapshot': audit_snapshot}
        if pending or os.path.exists(board_report):
            os.makedirs(folder, mode=0o700, exist_ok=True)
            handle, path = tempfile.mkstemp(prefix='board-', suffix='.json', dir=folder)
            with os.fdopen(handle, 'w') as stream:
                json.dump({'checkedAt': report['checkedAt'], 'boardPending': pending}, stream)
            os.replace(path, board_report)
        if audit_due:
            return None, 'scope_audit_due'
        if 'board_followups_due' in ap and ap['board_followups_due'](ap['load'](ap['BOARD'], {}), ap['now']()):
            return None, 'board_followup_due'
        if pending and report.get('factsUnchanged') is True and 'periodic_prompt' in ap:
            reason = partial_route(due, scope, proof, reviewed_at, report)
            if partial_evidence:
                return None, reason
            if not admission_current(due, proof, scope, reviewed_at)[1]:
                return None, 'admission_changed'
            report.update(agentReviewedAt=reviewed_at.isoformat())
            handle, path = tempfile.mkstemp(prefix='board-only-', suffix='.json', dir=folder)
            with os.fdopen(handle, 'w') as stream:
                json.dump(report, stream)
            board_only_evidence = path
            return None, 'board_only'
        if pending or report.get('changed') is not False:
            changes = report.get('changes') or {}
            kinds = sorted({row['kind'] for row in changes.get('checks', [])})
            if changes.get('registryChanged'):
                return None, 'registry_changed'
            if changes.get('scopeChanged'):
                return None, 'scope_changed'
            return None, partial_route(due, scope, proof, reviewed_at, report) or (
                'resume_due' if kinds == ['resume'] else 'facts_changed')
        findings = evidence.get('board_findings')
        if not isinstance(findings, list) or evidence.get('board_mismatches', []) not in ([], 0):
            return None, 'unverified_board'
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
            return None, partial_route(due, scope, proof, reviewed_at, report) or 'unverified_board'
        rest, current = admission_current(due, proof, scope, reviewed_at)
        if not current:
            return None, 'admission_changed'
        report.pop('changes', None)
        report.update(board_findings=findings, board_mismatches=[], board_snapshot_sha=evidence['board_snapshot_sha'],
                      boardVersions=evidence.get('boardVersions'),
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
        nonlocal board_only_evidence, partial_evidence, full_plan, full_evidence
        rest, decision = original(due, dry=True)
        if dry:
            return rest, decision
        if decision and decision.get('status') == 'would_delegate':
            try:
                handled, reason = quiet_checkpoint(due)
            except Exception:
                handled, reason = None, 'reconciliation_unavailable'
            if handled is not None:
                full_plan = None
                return handled
            try:
                if full_plan and not partial_evidence and not board_only_evidence and can_bind_checkpoint():
                    try:
                        full_evidence = write_evidence(evidence_folder(ap, config), 'full-', full_plan)
                    except OSError:
                        full_evidence = None
                rest, result = original(due, dry=False)
                handoff = partial_evidence or full_evidence
                if board_only_evidence and can_bind_checkpoint():
                    handoff = board_only_evidence
                if handoff and isinstance(result, dict) and not result.get('duplicate') and result.get('status') in ('started', 'queued', 'uncertain'):
                    try:
                        with open(handoff) as stream:
                            plan = json.load(stream)
                        plan['task'] = {key: result.get(key) for key in ('id', 'session', 'exec')}
                        os.replace(write_evidence(os.path.dirname(handoff), 'bound-', plan), handoff)
                    except OSError:
                        reason = 'checkpoint_binding_unavailable'
            finally:
                board_only_evidence = None
                partial_evidence = None
                full_plan = full_evidence = None
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
            if partial_evidence:
                command = shlex.join([sys.executable, *entrypoint, 'checkpoint-partial', '--input', partial_evidence])
                return (
                    f'정기 대조 부분 위임이다. 전체 범위의 코드 검증 증거는 {partial_evidence}이다. '
                    'checks의 PR·이슈·워크스페이스·세션·기한 도래 재개와 boardPending 행만 확인한다. '
                    'registry 항목은 그 PR의 장부 상태·전송 기록을 읽어 바뀐 근거를 확인한다. '
                    'PR은 prFacts의 head와 최근 결정 리뷰를 사용하고, 실행 중이거나 큐에 있는 동일 회차를 확인한다. '
                    '신규 리뷰 요청은 대상 PR의 읽기 전용 후보 검사로 기존 실행을 확인한다. '
                    '필요한 대상의 최신 head·리뷰·실행·queue만 다시 읽는다. 전체 목록을 재조회하지 않는다. '
                    'board 항목의 추가·수정 행은 현재 게시 상태·설명·대기 사유와 대조하고 삭제 행은 게시에서 빠졌는지 확인한다. '
                    '기존 보류·사용자 결정을 보존하고 승인·머지·전송·후보 등록·보드/장부 수정을 하지 않는다. '
                    '새 후보 등록이나 범위 밖 증거가 필요하거나 현재 head·리뷰·큐가 입력과 달라졌으면 '
                    'status=error로 끝내 다음 정기 대조에서 전체 절차를 수행하게 한다. '
                    '결과 JSON에는 status=ok, errors=[], changed, 입력 fingerprint, '
                    '검증한 checks의 version 목록 checked, board_mismatches, boardResolutions, autopilot_actions를 넣는다. '
                    '보드와 조치 항목은 기존 정기 대조의 형식을 사용한다. '
                    f'`{command} --evidence <결과 JSON의 절대경로>`로 공식 체크포인트를 작성한다. '
                    '결과의 evidence에는 이 명령이 반환한 확정 증거 파일 경로를 사용한다. '
                    '오류 또는 체크포인트 거부는 status=error, changed=true로 보고한다. '
                    '최종 응답 첫 줄은 RECONCILE 다음에 status, changed, summary, evidence의 JSON 한 줄이다.'
                )
            if board_only_evidence:
                executable = f'{ap["AP"]}/bin/ap checkpoint'
                receipt = ''
                if can_bind_checkpoint():
                    executable = shlex.join([sys.executable, *entrypoint, 'checkpoint-board', '--input', board_only_evidence])
                    receipt = '최종 결과의 evidence에는 이 명령이 반환한 확정 증거 경로를 넣는다. '
                return (
                    f'정기 대조 중 게시 보드만 확인한다. 코드가 현재 회차의 등록 PR·리뷰 발견·양 호스트 실행과 '
                    f'대기열을 검증했다. 원본 증거는 {board_only_evidence}이다. 전체 PR·이슈·세션 목록을 다시 조회하지 않는다. '
                    f'`{ap["AP"]}/bin/ap board snapshot`의 게시 행 전체를 최신 PR head와 리뷰 근거에 대조한다. '
                    'boardPending은 우선 확인할 항목이며, 목록 밖 게시 행의 상태·설명·대기 사유 불일치도 확인한다. '
                    '리뷰어별 최신 결정 리뷰의 commit과 현재 head를 대조한다. 조회 실패나 추가 비보드 변경을 발견하면 '
                    '체크포인트를 확정하지 말고 status=error, changed=true로 보고한다. '
                    '원본 JSON을 복사해 coverage와 agentReviewedAt을 보존한다. 새 증거에 board_snapshot_sha(현재 보드 SHA), '
                    'board_findings(모든 게시 PR의 pr_url, 최신 전체 head SHA, checked:true), '
                    'board_mismatches(불일치마다 pr_url, head, 필요한 경우 review_id, expected 정정값), '
                    'boardResolutions(대기 항목 key와 fingerprint, 게시가 맞으면 disposition=published와 rowSha256, '
                    '보류면 disposition=hold와 reason, owner, 2시간 이후 recheckAt)를 기록한다. '
                    '원본, 보드, 장부를 직접 변경하거나 후보 등록·전송·승인·알림을 하지 않는다. '
                    f'새 증거 파일로 `{executable} --evidence <절대경로>`를 실행한다. '
                    f'{receipt}'
                    '보드 SHA가 달라져 거부되면 새 스냅샷으로 다시 대조하거나 미완료로 보고한다. '
                    '성공 시 changed=false로 보드 불일치 후속 처리를 기존 회수 경로에 맡긴다. '
                    '최종 응답 첫 줄은 RECONCILE에 이어 status, changed, summary, evidence(새 파일 절대경로)를 담은 JSON 한 줄이다.'
                )
            prompt = original_prompt()
            if can_bind_checkpoint():
                command = [sys.executable, *entrypoint, 'checkpoint-full']
                if full_evidence:
                    command.extend(['--input', full_evidence])
                    prompt += (f' 코드의 읽기 전용 대조 증거는 {full_evidence}이다. '
                               '새로 전체 조회한 결과를 auditSnapshot의 prs·issues·hosts 자료와 대조한다. '
                               '각 그룹의 전체 항목과 버전(PR 상태·head·리뷰 ID·결정, 이슈 연결, 실행·큐·재개)을 확인한 경우에만 '
                               '그 그룹의 version을 결과 JSON auditReviewed의 같은 키에 넣는다. '
                               '차이가 있거나 비교할 수 없는 그룹은 생략한다. 전체 대조 결과 자체는 현재 확인한 상태를 사용한다.')
                executable = shlex.join(command)
                prompt = prompt.replace(f'{ap["AP"]}/bin/ap checkpoint --evidence', f'{executable} --evidence')
                prompt += (f' 공식 체크포인트는 `{executable} --evidence <결과 JSON의 절대경로>`로 작성한다. '
                           '최종 결과의 evidence에는 이 명령이 반환한 확정 증거 경로를 넣는다.')
            return (prompt +
                    ' System One 검증용으로 공식 증거에 coverage를 기록한다. 이번 대조 범위는 ' + expected + '이다. ' +
                    'projects의 각 프로젝트 review 태그 이슈, repositories의 review 요청 발견, hosts의 각 호스트 공간·실행·queue를 ' +
                    '모두 공식 조회로 확인한 경우에만 이 값을 그대로 coverage로 기록한다. 하나라도 못 했으면 coverage를 넣지 않는다. ' +
                    '증거 디렉터리의 board-reconciliation.json에 대기 항목이 있으면 각 key와 fingerprint를 확인하고, '
                    '게시 검증 시 disposition=published와 rowSha256을, 보류 시 disposition=hold와 reason, owner, recheckAt(지금부터 2시간 이상 뒤, 그 전엔 다음 대조가 보류를 다시 대기로 본다)을 boardResolutions에 기록한다.')

        ap['periodic_prompt'] = periodic_prompt


def custom_preset(current):
    return (current.get('variant') not in (None, 'DEFAULT')
            or current.get('agent_id') or current.get('sandbox_policy'))


def managed_autopilot_config(ap, current):
    """Only the policy's models and portable session settings can follow it."""
    executor, model = current.get('executor'), current.get('model_id')
    if not current.get('permission_policy') or custom_preset(current):
        return False
    if not ap['stage_of'](executor, model):
        return False
    if executor == 'CLAUDE_CODE' and model:
        return model == 'opus' or model.startswith('claude-opus-')
    if executor == 'CODEX' and model:
        return 'sol' in model.lower() and model.endswith('-fast')
    return True


def automatic_selection(ap, select, host, usage, profiles, current, **kwargs):
    source = current['executor']
    plan = select(host, usage, profiles, source=source, latest=current, own=False, **kwargs)
    if not plan['ok']:
        return plan
    target = plan['executor']
    reasoning = current.get('reasoning_id')
    if target != source:
        permission = current['permission_policy']
        allowed = plan.get('permissions') or ()
        if permission not in allowed and not (target == 'OPENCODE_V2' and permission == 'DONT_ASK' and 'AUTO' in allowed):
            return {**plan, 'ok': False, 'error': f'{target} cannot preserve permission policy {permission}'}
        reasoning = reasoning or ap['profile_reasoning'](profiles, source)
    if reasoning and reasoning not in [option['id'] for option in plan['model_info'].get('reasoning_options', [])]:
        return {**plan, 'ok': False, 'error': f'{target} cannot preserve reasoning level {reasoning}'}
    return {**plan, 'reasoning_id': reasoning}


def install_automatic_routing(ap, pinned=False):
    original = ap['select_for']

    def select(host, usage, profiles, *, requested=None, source=None, latest=None, own=False, **kwargs):
        if own and not requested and source and latest and latest.get('executor') == source:
            if not pinned and managed_autopilot_config(ap, latest):
                return automatic_selection(ap, original, host, usage, profiles, latest, **kwargs)
            if custom_preset(latest):
                # The legacy ap sender doesn't forward these overrides.
                plan = original(host, usage, profiles, source=source, latest=latest, own=True, **kwargs)
                return {**plan, 'ok': False, 'error': 'Automatic wake cannot preserve the session preset'}
        return original(host, usage, profiles, requested=requested, source=source, latest=latest, own=own, **kwargs)

    ap['select_for'] = select


def wire_automatic_sends(ap, adapter_args):
    original_send = ap['guarded_send']
    original_vk = ap['vk']
    original_note = ap['handoff_note']
    child = ap['subprocess']

    def popen(args, *rest, **kwargs):
        # The installed script starts these children by its own filename.
        # Carry the adapter through the real observation/watch launch, too.
        if (isinstance(args, list) and args[:3] == [sys.executable, '-I', os.path.abspath(ap['__file__'])]
                and len(args) > 3 and args[3] in ('sample', 'watch-send')):
            args = [sys.executable, '-I', *adapter_args, *args[3:]]
        return child.Popen(args, *rest, **kwargs)

    def send(session, message, host, **kwargs):
        key = kwargs.get('key') or ''
        if not (kwargs.get('queue') and not kwargs.get('requested')
                and key.startswith(('gate:', 'observation:'))):
            return original_send(session, message, host, **kwargs)

        def managed_vk(*args, **options):
            if args[:3] == ('session', 'send', session):
                # The host re-evaluates against the live config at start. Do
                # not send legacy profile overrides as if they were user pins.
                args = (*args[:5], '--queue', '--autopilot-policy', *ap['HOSTS'][host])
            return original_vk(*args, **options)

        ap['vk'] = managed_vk
        ap['handoff_note'] = lambda *args: 'If the executor changes, continue in this session using the existing work and conversation history.'
        try:
            return original_send(session, message, host, **kwargs)
        finally:
            ap['vk'] = original_vk
            ap['handoff_note'] = original_note

    ap['subprocess'] = SimpleNamespace(**{**vars(child), 'Popen': popen})
    ap['guarded_send'] = send


def probe_executor(ap, host, current):
    if not managed_autopilot_config(ap, current):
        return None
    with ThreadPoolExecutor(2) as pool:
        usage = pool.submit(ap['usage_snapshot'], host)
        profiles = pool.submit(ap['vk'], 'config', 'profiles', 'get', *ap['HOSTS'][host])
        plan = automatic_selection(ap, ap['select_for'], host, usage.result(), profiles.result(), current)
    if not plan['ok']:
        raise ValueError(plan['error'])
    return {'executor': plan['executor'], 'model_id': plan['model'], 'reasoning_id': plan['reasoning_id']}


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
    host = config.get('executorPolicyHost')
    command = next(iter(args.arguments), None)
    if command == 'executor-policy':
        if not host or len(args.arguments) != 3:
            parser.error('executor-policy needs a configured host, session ID and current executor config')
        # The host API already verified the active session and supplied its config.
        print(json.dumps(None if config.get('executorPolicyPinned') is True
                         else probe_executor(ap, host, json.loads(args.arguments[2]))))
        return 0
    if host:
        # All background children must carry the adapter when the host opts in.
        install_automatic_routing(ap, pinned=config.get('executorPolicyPinned') is True)
        wire_automatic_sends(ap, [
            os.path.abspath(__file__), '--ap', os.path.abspath(args.ap),
            '--config', os.path.abspath(args.config),
        ])
    if config.get('enabled') is True:
        if command in ('checkpoint-partial', 'checkpoint-full', 'checkpoint-board'):
            partial = command == 'checkpoint-partial'
            board_only = command == 'checkpoint-board'
            checkpoint = argparse.ArgumentParser(prog=command)
            checkpoint.add_argument('--input', required=partial or board_only)
            checkpoint.add_argument('--evidence', required=True)
            result = checkpoint.parse_args(args.arguments[1:])
            try:
                location = os.path.realpath(result.input) if result.input else None
                prefix = {'checkpoint-partial': 'partial', 'checkpoint-full': 'full', 'checkpoint-board': 'board-only'}[command]
                if location and (os.path.dirname(location) != os.path.realpath(evidence_folder(ap, config)) or
                                 not re.fullmatch(rf'{prefix}-[a-z0-9_]+\.json', os.path.basename(location))):
                    raise ValueError('대조 입력 경로가 일치하지 않음')
                if partial:
                    return checkpoint_partial(ap, config, location, result.evidence)
                plan = None
                if location:
                    with open(location) as stream:
                        plan = json.load(stream)
                return checkpoint_full(ap, config, result.evidence, plan, board_only=board_only)
            except (KeyError, TypeError, ValueError, OSError) as error:
                print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
                return 1
        install(ap, config, [os.path.abspath(__file__), '--ap', os.path.abspath(args.ap),
                             '--config', os.path.abspath(args.config)])
    sys.argv = [args.ap, *args.arguments]
    return ap['main']()


if __name__ == '__main__':
    sys.exit(main())
