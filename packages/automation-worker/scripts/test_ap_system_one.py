import argparse
import datetime as dt
import importlib.util
import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('ap_system_one', os.path.join(os.path.dirname(__file__), 'ap-system-one.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class PeriodicTests(unittest.TestCase):
    def fixture(self, decision='would_delegate', report=None, checkpoint=0):
        values = {'schedule': {key: [] for key in ('pending_admissions',)}, 'board': {'rows': {}}, 'dispatch': {'requests': {}}, 'deleg': {'tasks': {}}, 'inbox': {'items': {}}}
        calls = []
        namespace = {'calls': calls, 'decision': decision}
        exec("def periodic_gate(due, dry=False):\n calls.append(('gate',dry))\n return ['other'], {'status':decision if dry else 'legacy'}", namespace)
        namespace.update(SCHED='schedule', BOARD='board', DISPATCH='dispatch', DELEG='deleg', INBOX='inbox', AP=self.folder,
                         PENDING_KEYS=('pending_admissions',), CHECKPOINTS=(('a', 'at'), ('b', 'at')), CHECKPOINT_BY='ap checkpoint',
                         load=lambda path, default: values.get(path, default),
                         api=lambda path, body, **kwargs: calls.append(('request', body)) or report or {'status': 'ok', 'changed': False, 'errors': [], 'fingerprint': 'a' * 64, 'counts': {'issues': 0, 'prs': 0, 'hosts': 1}},
                         cmd_checkpoint=lambda args: calls.append(('checkpoint', args.evidence)) or checkpoint)
        config = {'connectorId': 'synthetic-vibe', 'githubConnectorId': 'synthetic-github', 'projectId': 'synthetic-project', 'reviewTagId': 'synthetic-tag', 'hosts': ['synthetic-machine'], 'defaultRepository': 'synthetic/widgets'}
        self.ap, self.config = namespace, config
        adapter.install(namespace, config)
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
 const collect=()=>collectReconciliation({scope,repositories:['synthetic/widgets'],discover:async()=>[],github:async()=>({}),vibe:async()=>({issues:[],total_count:0,offset:0}),host:async()=>({hostId:'synthetic-machine',complete:true,workspaces:[]})});
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
        result = adapter.registry(ap, config)
        self.assertEqual(result['acknowledgedAt'], '2001-02-03T00:00:00+00:00')

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
        self.assertEqual([name for name, _ in calls], ['gate', 'request', 'checkpoint'])
        self.assertTrue(os.path.isfile(result['evidence']))

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

    def test_unresolved_board_report_is_preserved_for_delegation_and_evidence_is_forwarded(self):
        pending = {'key': 'synthetic/widgets#17', 'head': 'b' * 40, 'fingerprint': 'c' * 64}
        report = {'status': 'ok', 'changed': True, 'errors': [], 'fingerprint': 'a' * 64,
                  'counts': {'issues': 1, 'prs': 1, 'hosts': 1}, 'checkedAt': '2002-03-04T00:00:00Z',
                  'boardPending': [pending]}
        gate, calls, values = self.fixture(report=report)
        self.ap.update(evidence_problems=lambda body: [], parse=dt.datetime.fromisoformat)
        self.config['boardNoteId'] = '20000000-0000-4000-8000-000000000001'
        values['board']['rows']['17'] = {'repo': 'synthetic/widgets'}
        proof = {'key': pending['key'], 'fingerprint': pending['fingerprint'],
                 'disposition': 'published', 'rowSha256': 'd' * 64}
        evidence = os.path.join(self.folder, 'agent-evidence.json')
        with open(evidence, 'w') as stream:
            json.dump({'status': 'ok', 'errors': [], 'boardResolutions': [proof]}, stream)
        values[evidence] = {'status': 'ok', 'errors': [], 'boardResolutions': [proof]}
        for key in ('a', 'b'):
            values['schedule'][key] = {'status': 'success', 'by': 'ap checkpoint',
                                       'evidence': evidence, 'at': '2002-03-04T00:00:00+00:00'}
        _, result = gate(['periodic due'])
        self.assertEqual(result['status'], 'legacy')
        body = next(value for name, value in calls if name == 'request')
        self.assertEqual(body['boardNoteId'], self.config['boardNoteId'])
        self.assertIn(proof, body['boardResolutions'])
        with open(os.path.join(self.folder, 'system-one-evidence', 'board-reconciliation.json')) as stream:
            self.assertEqual(json.load(stream)['boardPending'], [pending])


if __name__ == '__main__':
    unittest.main()
