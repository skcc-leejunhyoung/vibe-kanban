#!/usr/bin/env python3
"""Print the Autopilot ledger's ownership as the worker's legacy triage import.

Executions the Autopilot sent and the workspaces it delegated to are exactly
what `ap` itself treats as its own work. Hosts record agent origins from the
`execution_agent_origins` migration on; this covers what ran before it.

    python3 ap-legacy-owned.py --ap /path/to/ap | curl -X PUT -H 'content-type: application/json' \
        --data-binary @- http://127.0.0.1:<port>/api/automation/autopilot/triage
"""
import argparse
import json
import os
import re
import runpy
import sys

UUID = re.compile(r'^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$', re.I)


def owned(ap):
    executions = (ap['load'](ap['INBOX'], {}) or {}).get('dispatched') or {}
    workspaces = ap['ops_ws_ids']()
    keep = lambda values: sorted({v.lower() for v in values if isinstance(v, str) and UUID.match(v)})
    return {'legacy': {'executions': keep(executions), 'workspaces': keep(workspaces)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ap', required=True)
    args = parser.parse_args()
    namespace = runpy.run_path(os.path.abspath(args.ap), run_name='ap_legacy_owned')
    json.dump(owned(namespace), sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
