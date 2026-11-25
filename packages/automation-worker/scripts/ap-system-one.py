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
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

PR_URL = re.compile(r'https://github\.com/([^/]+/[^/]+)/pull/(\d+)')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
AGENT_AUDIT_INTERVAL = dt.timedelta(hours=2)
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
    stable.update(board={'rows': board.get('rows', {}), 'needs': board.get('needs', [])}, dispatch=requests)
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
    board_only_evidence = None

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

    def quiet_checkpoint(due):
        nonlocal board_only_evidence
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
        if isinstance(report, dict) and report.get('status') == 'deferred':
            # The GitHub budget is below the reserve; a delegated agent would spend
            # the same account's budget, so this cycle neither checks nor delegates.
            rest, _ = original(due, dry=True)
            return (rest, {'status': 'deferred', 'source': 'code', 'reason': report.get('reason'),
                           'remaining': report.get('remaining')}), None
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
        if pending and report.get('factsUnchanged') is True and 'periodic_prompt' in ap:
            if not admission_current(due, proof, scope, reviewed_at)[1]:
                return None, 'admission_changed'
            report.update(agentReviewedAt=reviewed_at.isoformat())
            handle, path = tempfile.mkstemp(prefix='board-only-', suffix='.json', dir=folder)
            with os.fdopen(handle, 'w') as stream:
                json.dump(report, stream)
            board_only_evidence = path
            return None, 'board_only'
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
        rest, current = admission_current(due, proof, scope, reviewed_at)
        if not current:
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
        nonlocal board_only_evidence
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
            try:
                rest, result = original(due, dry=False)
            finally:
                board_only_evidence = None
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
            if board_only_evidence:
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
                    f'새 증거 파일로 `{ap["AP"]}/bin/ap checkpoint --evidence <절대경로>`를 실행한다. '
                    '보드 SHA가 달라져 거부되면 새 스냅샷으로 다시 대조하거나 미완료로 보고한다. '
                    '성공 시 changed=false로 보드 불일치 후속 처리를 기존 회수 경로에 맡긴다. '
                    '최종 응답 첫 줄은 RECONCILE에 이어 status, changed, summary, evidence(새 파일 절대경로)를 담은 JSON 한 줄이다.'
                )
            return (original_prompt() +
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
        install(ap, config)
    sys.argv = [args.ap, *args.arguments]
    return ap['main']()


if __name__ == '__main__':
    sys.exit(main())
