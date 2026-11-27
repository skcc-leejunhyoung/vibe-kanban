import argparse
import datetime as dt
import hashlib
import importlib.util
import os
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('ap_system_one', os.path.join(os.path.dirname(__file__), 'ap-system-one.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AutopilotExecutorTests(unittest.TestCase):
    def setUp(self):
        self.usage = {'claude': 'over', 'codex': 'over'}
        self.current = {'executor': 'OPENCODE_V2', 'model_id': 'openai/example-sol',
                        'permission_policy': 'SUPERVISED', 'reasoning_id': 'low'}
        self.ap = {
            'HOSTS': {'synthetic-host': []},
            'usage_snapshot': lambda host: self.usage,
            'vk': lambda *args: {},
            'stage_of': lambda executor, model: 'policy' if model == 'openai/example-sol' else None,
            'profile_reasoning': lambda profiles, source: None,
            'select_for': self.select,
        }

    def select(self, host, usage, profiles, *, own, requested=None, source=None, latest=None, **kwargs):
        target = requested or (source if own or usage['codex'] == 'over' else 'CODEX')
        return {'ok': True, 'executor': target,
                'model': 'gpt-5.6-sol-fast' if target == 'CODEX' else latest['model_id'],
                'permissions': ['SUPERVISED'], 'model_info': {'reasoning_options': [{'id': 'low'}]}}

    def test_event_and_gate_pick_codex_sol_fast_on_the_next_automatic_send(self):
        adapter.install_automatic_routing(self.ap)
        def gate_pick(**kwargs):
            return self.ap['select_for']('synthetic-host', self.usage, {},
                                         source=self.current['executor'], latest=self.current, own=True, **kwargs)

        self.assertEqual(gate_pick()['executor'], 'OPENCODE_V2')
        self.assertEqual(adapter.probe_executor(self.ap, 'synthetic-host', self.current)['executor'], 'OPENCODE_V2')
        self.usage['codex'] = 'ok'  # Claude still over its weekly limit.
        self.assertEqual(gate_pick()['model'], 'gpt-5.6-sol-fast')
        self.assertEqual(adapter.probe_executor(self.ap, 'synthetic-host', self.current),
                         {'executor': 'CODEX', 'model_id': 'gpt-5.6-sol-fast', 'reasoning_id': 'low'})
        self.assertEqual(gate_pick(requested='OPENCODE_V2')['executor'], 'OPENCODE_V2')

    def test_user_model_and_session_security_settings_are_not_replaced(self):
        self.usage['codex'] = 'ok'
        for override in ({'model_id': 'example/pinned'}, {'variant': 'CUSTOM'}, {'sandbox_policy': 'read-only'},
                         {'agent_id': 'custom-mode'}, {'permission_policy': None}):
            with self.subTest(override=override):
                self.assertIsNone(adapter.probe_executor(self.ap, 'synthetic-host', {**self.current, **override}))
        with self.assertRaisesRegex(ValueError, 'cannot preserve permission'):
            adapter.probe_executor(self.ap, 'synthetic-host', {**self.current, 'permission_policy': 'PLAN'})

    def test_gate_and_observation_children_keep_the_host_policy_and_manual_send_does_not(self):
        calls = []
        self.ap.update(__file__='/synthetic/bin/ap', subprocess=SimpleNamespace(Popen=lambda args, **_: calls.append(args)),
                       handoff_note=lambda *args: 'legacy note',
                       vk=lambda *args, **_: calls.append(args))

        def send(session, message, host, **kwargs):
            return self.ap['vk']('session', 'send', session, '-m', message,
                                 '--executor', 'OPENCODE_V2', '--queue')

        self.ap['guarded_send'] = send
        argv = ['/synthetic/adapter.py', '--ap', '/synthetic/bin/ap', '--config', '/synthetic/config']
        adapter.wire_automatic_sends(self.ap, argv)
        self.ap['subprocess'].Popen([sys.executable, '-I', '/synthetic/bin/ap', 'sample', '--exec', 'synthetic-exec'])
        self.assertEqual(calls.pop(), [sys.executable, '-I', *argv, 'sample', '--exec', 'synthetic-exec'])
        for key in ('gate:synthetic', 'observation:synthetic'):
            self.ap['guarded_send']('synthetic-session', 'synthetic prompt', 'synthetic-host', key=key, queue=True)
            self.assertEqual(calls.pop(), ('session', 'send', 'synthetic-session', '-m', 'synthetic prompt',
                                           '--queue', '--autopilot-policy'))
        self.ap['guarded_send']('synthetic-session', 'synthetic prompt', 'synthetic-host',
                                key='manual:synthetic', requested='OPENCODE_V2', queue=True)
        self.assertIn('--executor', calls.pop())

    def test_explicit_session_pin_wins_even_when_it_matches_a_policy_model(self):
        self.usage['codex'] = 'ok'
        adapter.install_automatic_routing(self.ap, pinned=True)
        pinned = self.ap['select_for']('synthetic-host', self.usage, {}, own=True,
                                       source=self.current['executor'], latest=self.current)
        self.assertEqual(pinned['executor'], 'OPENCODE_V2')


class PeriodicTests(unittest.TestCase):
    def fixture(self, decision='would_delegate', report=None, checkpoint=0, prompt=False, entrypoint=None):
        values = {'schedule': {key: [] for key in ('pending_admissions',)}, 'board': {'rows': {}}, 'dispatch': {'requests': {}}, 'deleg': {'tasks': {}}, 'inbox': {'items': {}}}
        evidence_path = os.path.join(self.folder, 'official-evidence.json')
        coverage = {'projects': [{'projectId': 'synthetic-project', 'reviewTagId': 'synthetic-tag'}], 'hosts': ['synthetic-machine'], 'repositories': ['synthetic/widgets']}
        values[evidence_path] = {'status': 'ok', 'errors': [], 'coverage': coverage, 'board_findings': [], 'board_snapshot_sha': 'b' * 64}
        Path(evidence_path).write_text(json.dumps(values[evidence_path]))
        stamp = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)
        os.utime(evidence_path, (stamp.timestamp(), stamp.timestamp()))
        for key in ('a', 'b'):
            values['schedule'][key] = {'status': 'success', 'by': 'ap checkpoint', 'evidence': evidence_path, 'at': stamp.isoformat()}
        calls = []
        namespace = {'calls': calls, 'decision': decision}
        exec("def periodic_gate(due, dry=False):\n calls.append(('gate',dry))\n if not dry and 'periodic_prompt' in globals(): calls.append(('prompt', periodic_prompt()))\n return ['other'], {'status':decision} if dry else globals().get('delegation', {'status':'legacy'})", namespace)
        def api(path, body, **kwargs):
            calls.append(('request', dict(body)))
            return report if report is not None else {'status': 'ok', 'changed': False, 'errors': [], 'fingerprint': 'a' * 64,
                'counts': {'issues': 0, 'prs': len(body['tracked']), 'hosts': 1}, 'coverage': dict(coverage),
                'registryHash': body['registryHash'], 'checkedTracked': body['tracked'], 'boardPending': []}
        namespace.update(SCHED='schedule', BOARD='board', DISPATCH='dispatch', DELEG='deleg', INBOX='inbox', AP=self.folder,
                         PENDING_KEYS=('pending_admissions',), CHECKPOINTS=(('a', 'at'), ('b', 'at')), CHECKPOINT_BY='ap checkpoint',
                         load=lambda path, default: values.get(path, default),
                         api=api, parse=lambda value: dt.datetime.fromisoformat(value) if value else None,
                         now=lambda: stamp + dt.timedelta(hours=1),
                         evidence_problems=lambda evidence: [] if evidence and evidence.get('status') == 'ok' else ['invalid'],
                         verify_board_coverage=lambda evidence, mismatches: None,
                         cmd_checkpoint=lambda args: calls.append(('checkpoint', args.evidence)) or checkpoint)
        config = {'connectorId': 'synthetic-vibe', 'githubConnectorId': 'synthetic-github', 'projectId': 'synthetic-project', 'reviewTagId': 'synthetic-tag', 'hosts': ['synthetic-machine'], 'defaultRepository': 'synthetic/widgets'}
        if prompt:
            namespace['periodic_prompt'] = lambda: '전체 대조'
        self.ap, self.config = namespace, config
        adapter.install(namespace, config, entrypoint)
        return namespace['periodic_gate'], calls, values

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = self.temp.name

    def tearDown(self):
        self.temp.cleanup()

    def test_self_dispatch_and_rendering_do_not_change_the_registry(self):
        _, _, values = self.fixture()
        values['board']['rows']['17'] = {'repo': 'synthetic/widgets', 'status': 'waiting', 'updated_at': '2002-03-04T00:00:00Z'}
        before = adapter.registry(self.ap, self.config)['registryHash']
        values['deleg']['tasks']['synthetic-periodic'] = {'kind': 'periodic', 'session': 'synthetic-session', 'ws': '10000000-0000-4000-8000-000000000001'}
        values['dispatch']['requests']['delegate:synthetic-periodic'] = {'session': 'synthetic-session', 'pr': 17, 'status': 'completed'}
        values['dispatch']['last_selection'] = {'synthetic-machine': 'CODEX'}
        values['board']['last_render_at'] = '2002-03-04T00:05:00Z'
        values['board']['rows']['17']['updated_at'] = '2002-03-04T00:05:00Z'
        self.assertEqual(adapter.registry(self.ap, self.config)['registryHash'], before)
        values['board']['rows']['17']['status'] = 'cancelled'
        self.assertNotEqual(adapter.registry(self.ap, self.config)['registryHash'], before)
        values['dispatch']['requests']['synthetic-review'] = {'pr': 18, 'repo': 'synthetic/widgets', 'status': 'queued'}
        self.assertIn({'repository': 'synthetic/widgets', 'number': 18}, adapter.registry(self.ap, self.config)['tracked'])

    def test_dispatch_check_counter_alone_keeps_the_registry_version(self):
        _, _, values = self.fixture()
        row = {'pr': 17, 'status': 'uncertain', 'reconcile_checks': 1}
        values['dispatch']['requests']['synthetic-review'] = row
        before = adapter.registry(self.ap, self.config)
        row['reconcile_checks'] += 1
        self.assertEqual(adapter.registry(self.ap, self.config), before)
        row['status'] = 'started'
        after = adapter.registry(self.ap, self.config)
        self.assertNotEqual(after['registryHash'], before['registryHash'])
        self.assertNotEqual(after['registryIndex']['byPr'], before['registryIndex']['byPr'])

    def test_due_board_followup_takes_priority_over_partial_session_review(self):
        gate, calls, values = self.fixture(prompt=True, entrypoint=['/synthetic/adapter.py'])
        base = 'd' * 64
        values[str(Path(self.folder, 'official-evidence.json'))]['fingerprint'] = base
        self.ap.update(board_snapshot=lambda: {'sha': 'b' * 64, 'pr_urls': []},
                       periodic_active=lambda: None, board_followups_due=lambda *_: True)
        original_api = self.ap['api']
        changes = {'baseFingerprint': base, 'scopeChanged': False, 'registryChanged': False,
                   'checks': [{'kind': 'session', 'key': 'synthetic-session', 'version': 'e' * 64}],
                   'prFacts': {}, 'boardHeads': {}}
        self.ap['api'] = lambda *args, **kwargs: {
            **original_api(*args, **kwargs), 'changed': True, 'fingerprint': 'c' * 64,
            'changes': changes, 'checkedAt': self.ap['now']().isoformat(),
        }

        _, result = gate(['periodic due'])

        self.assertEqual(result['system_one_fallback'], 'board_followup_due')
        prompt = next(value for key, value in calls if key == 'prompt')
        self.assertTrue(prompt.startswith('전체 대조'))
        self.assertEqual(list(Path(self.folder, 'system-one-evidence').glob('partial-*.json')), [])

    def test_partial_gate_binds_official_checkpoint_to_audit_and_execution(self):
        gate, calls, values = self.fixture(prompt=True, entrypoint=['/synthetic/adapter.py'])
        session, execution = 'synthetic-session', 'synthetic-execution'
        task = {'id': 'synthetic-task', 'session': session, 'exec': execution, 'status': 'started'}
        board = {'sha': 'b' * 64, 'pr_urls': []}
        def verify_board(evidence, mismatches):
            if evidence['board_snapshot_sha'] != board['sha']:
                raise ValueError('보드 변경')
        fingerprint, base, version = 'c' * 64, 'd' * 64, 'e' * 64
        values[str(Path(self.folder, 'official-evidence.json'))]['fingerprint'] = base
        self.ap.update(delegation=task, periodic_active=lambda: task, board_snapshot=lambda: board,
                       verify_board_coverage=verify_board)
        original_api = self.ap['api']
        changes = {'baseFingerprint': base, 'scopeChanged': False, 'registryChanged': False,
                   'checks': [{'kind': 'session', 'key': session, 'version': version}],
                   'prFacts': {}, 'boardHeads': {}}
        self.ap['api'] = lambda *a, **kw: {**original_api(*a, **kw), 'changed': True,
                                          'fingerprint': fingerprint, 'changes': changes,
                                          'checkedAt': self.ap['now']().isoformat()}
        _, result = gate(['periodic due'])
        self.assertEqual(result['system_one_fallback'], 'partial:session')
        prompt = next(v for k, v in calls if k == 'prompt')
        self.assertIn('checkpoint-partial', prompt)
        self.assertNotIn('전체 대조', prompt)
        path, = Path(self.folder, 'system-one-evidence').glob('partial-*.json')
        result_path = Path(self.folder, 'synthetic-result.json')
        evidence = {'status': 'ok', 'errors': [], 'changed': False, 'fingerprint': fingerprint,
                    'checked': [version], 'board_mismatches': [], 'boardResolutions': [], 'autopilot_actions': []}
        result_path.write_text(json.dumps(evidence))
        with patch.dict(os.environ, VK_SESSION_ID=session, VK_EXECUTION_ID='other'):
            with self.assertRaisesRegex(ValueError, '위임 실행'):
                adapter.checkpoint_partial(self.ap, self.config, path, result_path)
        with patch.dict(os.environ, VK_SESSION_ID=session, VK_EXECUTION_ID=execution):
            result_path.write_text(json.dumps({**evidence, 'checked': []}))
            with self.assertRaisesRegex(ValueError, '증거의 버전'):
                adapter.checkpoint_partial(self.ap, self.config, path, result_path)
            result_path.write_text(json.dumps(evidence))
            row = {'pr': 18, 'status': 'queued'}
            values['dispatch']['requests']['synthetic-review'] = row
            with self.assertRaisesRegex(ValueError, '장부 변경'):
                adapter.checkpoint_partial(self.ap, self.config, path, result_path)
            values['dispatch']['requests'].clear()
            board['sha'] = 'f' * 64
            with self.assertRaisesRegex(ValueError, '보드 변경'):
                adapter.checkpoint_partial(self.ap, self.config, path, result_path)
            board['sha'] = 'b' * 64
            self.assertEqual(adapter.checkpoint_partial(self.ap, self.config, path, result_path), 0)
        checkpoints = [v for k, v in calls if k == 'checkpoint']
        self.assertEqual(len(checkpoints), 1)
        merged = json.loads(Path(checkpoints[0]).read_text())
        self.assertEqual(merged['agentReviewedAt'], '2020-01-01T00:00:00+00:00')
        self.assertEqual(merged['acknowledgedFingerprint'], fingerprint)

    def test_full_checkpoint_binds_matching_observations_and_preserves_unbound_success(self):
        gate, calls, values = self.fixture(prompt=True, entrypoint=['/synthetic/adapter.py'])
        task = {'id': 'synthetic-task', 'session': 'synthetic-session', 'exec': 'synthetic-execution', 'status': 'started',
                'at': (self.ap['now']() - dt.timedelta(minutes=1)).isoformat()}
        body = '## Synthetic board\n'
        board = {'sha': hashlib.sha256(body.strip().encode()).hexdigest(), 'pr_urls': [], 'body': body}
        self.ap.update(delegation=task, periodic_active=lambda: task, board_snapshot=lambda: board)
        audit = {key: {'version': letter * 64, 'facts': []}
                 for key, letter in (('prs', 'a'), ('issues', 'b'), ('hosts', 'c'))}
        audit['prs']['facts'] = [{'key': 'synthetic/widgets#17', 'aliases': [], 'head': 'd' * 40}]
        original_api = self.ap['api']
        self.ap['api'] = lambda *a, **kw: {**original_api(*a, **kw), 'changed': True, 'auditSnapshot': audit,
                                          'checkedAt': self.ap['now']().isoformat()}
        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'missing_change_baseline')
        self.assertIn('checkpoint-full --input', next(v for k, v in calls if k == 'prompt'))
        input_path, = Path(self.folder, 'system-one-evidence').glob('full-*.json')
        plan = json.loads(input_path.read_text())
        result_path = Path(self.folder, 'synthetic-result.json')
        checks = {key: group['version'] for key, group in audit.items()}
        result = {'status': 'ok', 'errors': [], 'coverage': plan['coverage'], 'board_findings': [],
                  'board_snapshot_sha': board['sha'], 'acknowledgedFingerprint': 'f' * 64}

        with patch.dict(os.environ, VK_SESSION_ID=task['session'], VK_EXECUTION_ID=task['exec']):
            result_path.write_text(json.dumps({**result, 'auditReviewed': {**checks, 'hosts': 'f' * 64}}))
            self.assertEqual(adapter.checkpoint_full(self.ap, self.config, result_path, plan), 0)
            result_path.write_text(json.dumps({**result, 'auditReviewed': checks}))
            # Reporting a newly tracked PR can bind only if the worker saw it already.
            values['schedule']['tracked_reconcile_checkpoint'] = {
                'heads': {'https://github.com/synthetic/widgets/pull/18': 'd' * 40}}
            self.assertEqual(adapter.checkpoint_full(self.ap, self.config, result_path, plan), 0)
            values['schedule']['tracked_reconcile_checkpoint']['heads'] = {
                'https://github.com/synthetic/widgets/pull/17': 'd' * 40}
            self.assertEqual(adapter.checkpoint_full(self.ap, self.config, result_path, plan), 0)
            stale = (self.ap['now']() - dt.timedelta(minutes=2)).timestamp()
            os.utime(result_path, (stale, stale))
            with self.assertRaisesRegex(ValueError, '이전의 전체 대조 증거'):
                adapter.checkpoint_full(self.ap, self.config, result_path, plan)

        unbound, unknown_pr, bound = [json.loads(Path(v).read_text()) for k, v in calls if k == 'checkpoint']
        self.assertNotIn('acknowledgedFingerprint', unbound)
        self.assertNotIn('acknowledgedFingerprint', unknown_pr)
        self.assertEqual(bound['acknowledgedFingerprint'], plan['fingerprint'])
        self.assertEqual(bound['boardVersions']['sha'], board['sha'])

    def test_board_add_edit_remove_delegates_rows_but_context_change_requires_full_review(self):
        gate, calls, values = self.fixture(prompt=True, entrypoint=['/synthetic/adapter.py'])
        url = lambda pr: f'https://github.com/synthetic/widgets/pull/{pr}'
        def snapshot(rows, context='None'):
            body = '## Synthetic board\n' + ''.join(f'| [PR]({url(pr)}) | {desc} | Waiting |\n' for pr, desc in rows)
            body += f'\n## Decisions\n{context}\n'
            return {'body': body, 'sha': hashlib.sha256(body.strip().encode()).hexdigest(),
                    'pr_urls': [url(pr) for pr, _ in rows]}
        old = snapshot([(17, 'unchanged'), (18, 'removed'), (19, 'before edit')])
        current = snapshot([(17, 'unchanged'), (19, 'after edit'), (20, 'added')])
        fingerprint = 'd' * 64
        values[values['schedule']['a']['evidence']].update(
            fingerprint=fingerprint, board_snapshot_sha=old['sha'], boardVersions=adapter.board_versions(old),
            board_findings=[{'pr_url': u, 'head': 'c' * 40, 'checked': True} for u in old['pr_urls']])
        self.config['tracked'] = [{'repository': 'synthetic/widgets', 'number': pr} for pr in (17, 18, 19, 20)]
        self.ap.update(board_snapshot=lambda: current, periodic_active=lambda: None,
                       verify_board_coverage=lambda *_: (_ for _ in ()).throw(ValueError('board changed')))
        original_api = self.ap['api']
        keys = ['synthetic/widgets#17', 'synthetic/widgets#19', 'synthetic/widgets#20']
        changes = {'baseFingerprint': fingerprint, 'scopeChanged': False, 'registryChanged': False, 'checks': [],
                   'boardHeads': dict.fromkeys(keys, 'c' * 40), 'prFacts': {key: {'head': 'c' * 40} for key in keys}}
        self.ap['api'] = lambda *a, **kw: {**original_api(*a, **kw), 'changes': changes,
                                          'checkedAt': self.ap['now']().isoformat()}

        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'partial:board')
        path, = Path(self.folder, 'system-one-evidence').glob('partial-*.json')
        plan = json.loads(path.read_text())
        self.assertEqual([row['key'] for row in plan['checks']], ['synthetic/widgets#18', 'synthetic/widgets#19', 'synthetic/widgets#20'])
        self.assertEqual([row['pr_url'] for row in plan['board_findings']], current['pr_urls'])
        self.assertEqual(set(plan['prFacts']), {'synthetic/widgets#19', 'synthetic/widgets#20'})
        current = snapshot([(17, 'unchanged'), (19, 'after edit'), (20, 'added')], 'New decision')
        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'board_context_changed')

    def test_host_facts_watch_only_registered_review_sessions(self):
        _, _, values = self.fixture()
        review, pending = '10000000-0000-4000-8000-0000000000AA', '10000000-0000-4000-8000-0000000000bb'
        values['deleg']['tasks']['synthetic-periodic'] = {'kind': 'periodic', 'session': '10000000-0000-4000-8000-0000000000cc'}
        values['dispatch']['requests']['delegate:synthetic-periodic'] = {'session': '10000000-0000-4000-8000-0000000000cc', 'pr': 17}
        values['dispatch']['requests']['synthetic-review'] = {'session': review, 'pr': 18, 'repo': 'synthetic/widgets'}
        values['dispatch']['requests']['synthetic-note'] = {'session': '10000000-0000-4000-8000-0000000000dd'}
        values['schedule']['pending_admissions'] = [{'pr': 19, 'session_id': pending}, {'pr': 20, 'session_id': 'not-a-session'}]
        self.assertEqual(adapter.registry(self.ap, self.config)['watchSessions'], [review.lower(), pending])
        ledger = '10000000-0000-4000-8000-0000000000ee'   # 리뷰 장부에만 남은 세션
        values[os.path.join(self.folder, 'pr-reviews.json')] = {'reviews': {'synthetic/widgets#21': {'session_id': ledger}}}
        self.assertEqual(adapter.registry(self.ap, self.config)['watchSessions'], [review.lower(), pending, ledger])

    def test_one_agent_checkpoint_establishes_a_quiet_baseline(self):
        _, _, values = self.fixture()
        self.config['projectId'] = '20000000-0000-4000-8000-000000000001'
        self.config['reviewTagId'] = '20000000-0000-4000-8000-000000000002'
        scopes = []
        for index in range(4):
            scopes.append(adapter.registry(self.ap, self.config))
            values['dispatch']['requests']['delegate:synthetic-' + str(index)] = {'status': 'completed', 'session': 'synthetic-' + str(index)}
        module = (Path(spec.origin).parent.parent / 'src' / 'autopilot-reconcile.mjs').as_uri()
        source = "import {reconcileAutopilot,collectReconciliation} from " + json.dumps(module) + ";" + """
import {readFileSync} from 'node:fs';
const scopes=JSON.parse(readFileSync(0,'utf8'));const record={};const flags=[];let now=Date.parse('2002-03-04T00:00:00Z');
for(const [index,scope] of scopes.entries()){
 now+=1800000;
 const collect=()=>collectReconciliation({scope,repositories:['synthetic/widgets'],discover:async()=>[],github:async()=>({}),vibe:async(method)=>method==='GET'?{id:scope.reviewTagId,project_id:scope.projectId}:{issues:[],total_count:0,offset:0},host:async()=>({hostId:'synthetic-machine',complete:true,workspaces:[]})});
 flags.push((await reconcileAutopilot({scope,record,collect,persist:async()=>{},now:()=>now,acknowledgedAt:index?new Date(now-1500000).toISOString():undefined})).changed);
}
console.log(JSON.stringify(flags));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', source], input=json.dumps(scopes), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), [True, False, False, False])

    def test_acknowledgement_cannot_be_newer_than_its_evidence(self):
        path = os.path.join(self.folder, 'evidence.json')
        with open(path, 'w') as stream:
            json.dump({'status': 'ok', 'errors': []}, stream)
        old = dt.datetime(2001, 2, 3, tzinfo=dt.timezone.utc).timestamp()
        os.utime(path, (old, old))
        checkpoint = {'status': 'success', 'by': 'ap checkpoint', 'evidence': path, 'at': '2002-03-04T00:00:00+00:00'}
        values = {'schedule': {'first': checkpoint, 'second': checkpoint}, 'board': {'rows': {}}, 'dispatch': {}, 'deleg': {}}
        ap = {'SCHED': 'schedule', 'BOARD': 'board', 'DISPATCH': 'dispatch', 'DELEG': 'deleg', 'PENDING_KEYS': (), 'CHECKPOINTS': (('first', 'at'), ('second', 'at')), 'CHECKPOINT_BY': 'ap checkpoint',
              'load': lambda name, default: {'status': 'ok', 'errors': []} if name == path else values.get(name, default), 'evidence_problems': lambda value: [], 'parse': dt.datetime.fromisoformat}
        config = {'connectorId': 'synthetic-vibe', 'githubConnectorId': 'synthetic-github', 'projectId': 'synthetic-project', 'reviewTagId': 'synthetic-tag', 'hosts': ['synthetic-machine']}
        _, acknowledged = adapter.checkpoint_proof(ap)
        self.assertEqual(acknowledged.isoformat(), '2001-02-03T00:00:00+00:00')

    def test_default_off_entrypoint_keeps_original_main(self):
        path = os.path.join(self.folder, 'synthetic-ap.py')
        config = os.path.join(self.folder, 'config.json')
        with open(path, 'w') as stream:
            stream.write("import sys,json\ndef periodic_gate(due,dry=False): return None\ndef main(): print(json.dumps(sys.argv[1:])); return 0\n")
        with open(config, 'w') as stream:
            json.dump({}, stream)
        result = subprocess.run([sys.executable, spec.origin, '--ap', path, '--config', config, 'gate'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), ['gate'])

    def test_quiet_result_uses_official_checkpoint_without_delegation(self):
        gate, calls, _ = self.fixture()
        _, result = gate(['periodic due'])
        self.assertEqual(result['status'], 'handled')
        self.assertEqual([name for name, _ in calls], ['gate', 'request', 'gate', 'checkpoint'])
        self.assertTrue(os.path.isfile(result['evidence']))

    def test_partial_or_unproven_scope_cannot_checkpoint(self):
        for change in ('missing', 'projects', 'short_project_list', 'invalid_project_list', 'repository', 'host', 'remote_subset', 'partial_tracked', 'registry', 'different_checkpoint'):
            with self.subTest(change=change):
                gate, calls, values = self.fixture()
                evidence = values[values['schedule']['a']['evidence']]
                request = self.ap['api']
                if change == 'missing':
                    evidence.pop('coverage')
                elif change == 'projects':
                    evidence['counts'] = {'projects': 2}
                elif change == 'short_project_list':
                    evidence['counts'] = {'projects': []}
                elif change == 'invalid_project_list':
                    evidence['counts'] = {'projects': [True]}
                elif change == 'repository':
                    values['schedule']['pending_admissions'].append({'pr': 7, 'repo': 'synthetic/sibling'})
                elif change == 'host':
                    evidence['coverage']['hosts'] = ['synthetic-machine', 'synthetic-other']
                elif change == 'different_checkpoint':
                    values['schedule']['b']['evidence'] = 'other-evidence'
                else:
                    evidence['coverage']['repositories'].append('synthetic/sibling')
                    values['schedule']['pending_admissions'].append({'pr': 7, 'repo': 'synthetic/widgets'})

                    def reconcile(*args, **kwargs):
                        report = request(*args, **kwargs)
                        if change == 'remote_subset':
                            report['coverage']['repositories'] = ['synthetic/widgets']
                        elif change == 'registry':
                            report['registryHash'] = 'c' * 64
                        else:
                            report['checkedTracked'] = []
                        return report

                    self.ap['api'] = reconcile
                _, result = gate(['periodic due'])
                self.assertEqual(result['status'], 'legacy')
                self.assertIn(result['system_one_fallback'], {'missing_scope_proof', 'scope_mismatch', 'incomplete_coverage'})
                self.assertFalse(any(name == 'checkpoint' for name, _ in calls))

    def test_identity_wait_falls_back_only_when_a_recheck_became_due(self):
        for due, expected in [('2019-01-01T00:00:00+00:00', 'handled'), ('2020-01-01T00:30:00+00:00', 'legacy'), ('2020-01-01T01:30:00+00:00', 'handled')]:
            gate, calls, values = self.fixture()
            values['schedule']['pending_admissions'] = [{'pr': 7, 'status': 'needs_identity', 'next_check_at': due}]
            old_wait = dict(values['schedule']['pending_admissions'][0])
            _, result = gate(['periodic due'])
            self.assertEqual(result['status'], expected)
            if expected == 'legacy':
                self.assertEqual(result['system_one_fallback'], 'identity_recheck_due')
                self.assertFalse(any(name == 'request' for name, _ in calls))
            self.assertEqual(values['schedule']['pending_admissions'][0], old_wait)

    def test_complete_multiple_projects_reach_checkpoint_and_carry_agent_audit_time(self):
        gate, calls, values = self.fixture()
        evidence = values[values['schedule']['a']['evidence']]
        evidence['coverage']['projects'].append({'projectId': 'synthetic-other-project', 'reviewTagId': 'synthetic-other-tag'})
        self.config['projects'] = [dict(project, connectorId='synthetic-other-connector') for project in evidence['coverage']['projects']]
        evidence['counts'] = {'projects': [4, 0]}
        _, handled = gate(['periodic due'])
        self.assertEqual(handled['status'], 'handled')
        derived = json.loads(Path(handled['evidence']).read_text())
        self.assertEqual(derived['agentReviewedAt'], values['schedule']['a']['at'])
        original_now = self.ap['now']
        values[handled['evidence']] = derived
        for key in ('a', 'b'):
            values['schedule'][key].update(evidence=handled['evidence'], at=original_now().isoformat())
        self.ap['now'] = lambda: original_now() + dt.timedelta(minutes=30)
        calls.clear()
        self.assertEqual(gate(['periodic due'])[1]['status'], 'handled')
        request = next(body for name, body in calls if name == 'request')
        self.assertEqual(request['acknowledgedAt'], derived['agentReviewedAt'])
        self.ap['now'] = lambda: original_now() + dt.timedelta(hours=1)
        calls.clear()
        _, fallback = gate(['periodic due'])
        self.assertEqual(fallback['system_one_fallback'], 'scope_audit_due')
        self.assertFalse(any(name == 'request' for name, _ in calls))

    def test_read_only_and_renamed_repositories_reach_checkpoint(self):
        gate, calls, values = self.fixture()
        values['schedule']['pending_admissions'].append({'pr': 7, 'repo': 'synthetic/old-name'})
        values['schedule']['pending_admissions'].append({'pr': 9, 'repo': 'synthetic/other'})
        evidence = values[values['schedule']['a']['evidence']]
        evidence['board_findings'] = [{'pr_url': 'https://github.com/synthetic/widgets/pull/7'}]
        # Outside the agent's discovery coverage and not declared readable: unproven.
        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'scope_mismatch')
        calls.clear()
        self.config.update(readRepositories=['synthetic/Other', 'synthetic/old-name'],
                           repositoryAliases={'synthetic/old-name': 'synthetic/widgets'})
        _, handled = gate(['periodic due'])
        self.assertEqual(handled['status'], 'handled')
        request = next(body for name, body in calls if name == 'request')
        self.assertEqual(request['readRepositories'], ['synthetic/old-name', 'synthetic/other'])
        # A finding under a name no alias maps cannot be verified.
        evidence['board_findings'] = [{'pr_url': 'https://github.com/synthetic/unknown/pull/7'}]
        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'unverified_board')

    def test_repositories_the_agent_checkpointed_are_read_without_declaration(self):
        gate, calls, values = self.fixture()
        values['schedule']['tracked_reconcile_checkpoint'] = {'heads': {'https://github.com/Synthetic/Outside/pull/3': 'a' * 40}}
        _, handled = gate(['periodic due'])
        self.assertEqual(handled['status'], 'handled')
        request = next(body for name, body in calls if name == 'request')
        self.assertEqual(request['readRepositories'], ['synthetic/outside'])
        # Past the worker's limit only declared repositories are read: unproven.
        values['schedule']['tracked_reconcile_checkpoint']['heads'].update(
            {f'https://github.com/synthetic/extra-{n}/pull/1': 'b' * 40 for n in range(20)})
        self.assertEqual(gate(['periodic due'])[1]['system_one_fallback'], 'scope_mismatch')

    def test_periodic_prompt_names_the_exact_scope_to_record(self):
        namespace = {'calls': []}
        exec("def periodic_gate(due, dry=False):\n return due, None\ndef periodic_prompt():\n return 'base.'", namespace)
        config = {'connectorId': 'synthetic-vibe', 'githubConnectorId': 'synthetic-github', 'hosts': ['synthetic-machine'],
                  'defaultRepository': 'synthetic/widgets',
                  'projects': [{'connectorId': 'synthetic-vibe', 'projectId': 'synthetic-project', 'reviewTagId': 'synthetic-tag'}]}
        adapter.install(namespace, config)
        prompt = namespace['periodic_prompt']()
        self.assertTrue(prompt.startswith('base.'))
        self.assertIn('{"projects":[{"projectId":"synthetic-project","reviewTagId":"synthetic-tag"}],'
                      '"repositories":["synthetic/widgets"],"hosts":["synthetic-machine"]}', prompt)

    def test_board_drift_cannot_be_checkpointed_even_when_worker_is_quiet(self):
        gate, calls, _ = self.fixture()
        def verify(*args):
            raise ValueError('synthetic board drift')
        self.ap['verify_board_coverage'] = verify
        _, result = gate(['periodic due'])
        self.assertEqual(result['system_one_fallback'], 'unverified_board')
        self.assertFalse(any(name == 'checkpoint' for name, _ in calls))

    def test_stale_quiet_result_does_not_checkpoint(self):
        for change in ('hold', 'registry'):
            gate, calls, values = self.fixture()
            request = self.ap['api']

            def reconcile(*args, **kwargs):
                result = request(*args, **kwargs)
                if change == 'hold':
                    self.ap['decision'] = 'cancelled'
                else:
                    values['board']['rows']['17'] = {'status': 'cancelled', 'repo': 'synthetic/widgets'}
                return result

            self.ap['api'] = reconcile
            _, result = gate(['periodic due'])
            self.assertEqual(result['status'], 'legacy')
            self.assertFalse(any(name == 'checkpoint' for name, _ in calls))

    def test_cancellation_inflight_and_backoff_preserve_original_gate(self):
        for decision in ('cancelled', 'in_flight', 'backoff', 'existing_delegation'):
            gate, calls, _ = self.fixture(decision)
            gate(['periodic due'])
            self.assertFalse(any(name == 'checkpoint' for name, _ in calls))

    def test_changed_failed_or_uncheckpointed_results_fall_back(self):
        for report, checkpoint in [({'status': 'ok', 'changed': True}, 0), ({'status': 'error'}, 0), ({'status': 'ok', 'changed': False, 'errors': []}, 0), ({'status': 'ok', 'changed': False, 'errors': []}, 0), (None, 1)]:
            gate, calls, _ = self.fixture(report=report, checkpoint=checkpoint)
            _, result = gate(['periodic due'])
            self.assertEqual(result['status'], 'legacy')
            self.assertEqual(calls[-1], ('gate', False))

    def test_github_budget_defers_until_worker_reset_without_another_request(self):
        gate, calls, values = self.fixture()
        self.ap['GATE_STATE'] = 'gate state'
        self.ap['save'] = lambda key, value: values.update({key: value})
        initial = self.ap['now']()
        retry_at = int((initial + dt.timedelta(minutes=20)).timestamp())
        request = self.ap['api']
        self.ap['api'] = lambda *args, **kwargs: {
            'status': 'deferred', 'reason': 'github_budget_low',
            'remaining': 7, 'retryAt': retry_at,
        }
        self.assertEqual(gate(['periodic due'])[1]['retryAt'], retry_at)
        self.ap['api'] = request
        self.ap['now'] = lambda: initial + dt.timedelta(minutes=5)
        calls.clear()
        self.assertEqual(gate(['periodic due'])[1]['status'], 'deferred')
        self.assertNotIn('request', [name for name, _ in calls])
        self.ap['now'] = lambda: initial + dt.timedelta(minutes=20)
        self.assertEqual(gate(['periodic due'])[1]['status'], 'handled')
        self.assertIn('request', [name for name, _ in calls])

    def test_low_github_budget_defers_without_delegating(self):
        gate, calls, _ = self.fixture(report={'status': 'deferred', 'reason': 'github_budget_low', 'remaining': 10})
        rest, result = gate(['periodic due'])
        self.assertEqual((rest, result['status'], result['reason']), (['other'], 'deferred', 'github_budget_low'))
        self.assertNotIn(('gate', False), calls)
        self.assertFalse(any(call[0] == 'checkpoint' for call in calls))

    def test_board_keys_are_registered_and_pending_states_are_preserved(self):
        gate, calls, values = self.fixture()
        values['board']['rows']['17'] = {'status': 'cancelled', 'repo': 'synthetic/widgets'}
        values['schedule']['pending_admissions'] = [{'pr': 18, 'status': 'waiting', 'repo': 'synthetic/widgets'}]
        values['schedule']['tracked_reconcile_checkpoint'] = {'heads': {'https://github.com/synthetic/widgets/pull/19': 'synthetic-head'}}
        before = repr(values)
        gate(['periodic due'])
        self.assertEqual(repr(values), before)
        body = next(value for name, value in calls if name == 'request')
        self.assertEqual(body['tracked'], [{'repository': 'synthetic/widgets', 'number': 17}, {'repository': 'synthetic/widgets', 'number': 18}, {'repository': 'synthetic/widgets', 'number': 19}])
        self.assertEqual(body['boardPrs'], ['synthetic/widgets#17'])

    def test_board_only_reuses_scope_proof_without_limiting_checks_to_pending_rows(self):
        for unchanged in (True, False):
            with self.subTest(unchanged=unchanged):
                gate, calls, _ = self.fixture(prompt=True)
                api = self.ap['api']
                self.ap['api'] = lambda *args, **kwargs: {
                    **api(*args, **kwargs), 'changed': True, 'factsUnchanged': unchanged,
                    'checkedAt': self.ap['now']().isoformat(),
                    'boardPending': [{'key': 'synthetic/widgets#17', 'head': 'b' * 40, 'fingerprint': 'c' * 64}],
                }
                _, result = gate(['periodic due'])
                prompt = next(value for name, value in calls if name == 'prompt')
                self.assertNotIn('checkpoint', [name for name, _ in calls])
                if unchanged:
                    self.assertEqual(result['system_one_fallback'], 'board_only')
                    self.assertIn('게시 행 전체', prompt)
                    self.assertIn('목록 밖 게시 행', prompt)
                    self.assertNotIn('전체 대조', prompt)
                    paths = list(Path(self.folder, 'system-one-evidence').glob('board-only-*.json'))
                    report = json.loads(paths[0].read_text())
                    self.assertEqual(report['coverage']['repositories'], ['synthetic/widgets'])
                    self.assertEqual(report['agentReviewedAt'], '2020-01-01T00:00:00+00:00')
                else:
                    self.assertEqual(result['system_one_fallback'], 'facts_changed')
                    self.assertIn('전체 대조', prompt)
                self.assertIn('전체 대조', self.ap['periodic_prompt']())

    def test_unresolved_board_report_is_preserved_for_delegation_and_evidence_is_forwarded(self):
        pending = {'key': 'synthetic/widgets#17', 'head': 'b' * 40, 'fingerprint': 'c' * 64}
        gate, calls, values = self.fixture()
        api = self.ap['api']
        self.ap['api'] = lambda *args, **kwargs: {
            **api(*args, **kwargs), 'changed': True, 'checkedAt': self.ap['now']().isoformat(),
            'boardPending': [pending],
        }
        self.config['boardNoteId'] = '20000000-0000-4000-8000-000000000001'
        values['board']['rows']['17'] = {'repo': 'synthetic/widgets'}
        proof = {'key': pending['key'], 'fingerprint': pending['fingerprint'],
                 'disposition': 'published', 'rowSha256': 'd' * 64}
        values[values['schedule']['a']['evidence']]['boardResolutions'] = [proof]
        _, result = gate(['periodic due'])
        self.assertEqual(result['status'], 'legacy')
        body = next(value for name, value in calls if name == 'request')
        self.assertEqual(body['boardNoteId'], self.config['boardNoteId'])
        self.assertIn(proof, body['boardResolutions'])
        with open(os.path.join(self.folder, 'system-one-evidence', 'board-reconciliation.json')) as stream:
            self.assertEqual(json.load(stream)['boardPending'], [pending])


if __name__ == '__main__':
    unittest.main()
