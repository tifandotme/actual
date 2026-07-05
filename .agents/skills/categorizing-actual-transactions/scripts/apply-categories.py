#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
from pathlib import Path

updates = json.loads(Path('.categorize/latest/category-updates.json').read_text())
data_dir = os.path.abspath('.categorize/actual-cache')
log_path = Path('.categorize/latest/apply-categories.log')
env = os.environ.copy()
env['ACTUAL_DATA_DIR'] = data_dir


def run(command, log):
    return subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, text=True)


with log_path.open('a') as log:
    for index, update in enumerate(updates, 1):
        command = [
            'bunx', '@actual-app/cli@latest', '--lock-timeout', '60',
            'transactions', 'update', update['id'],
            '--data', json.dumps({'category': update['category']}),
            '--format', 'json',
        ]
        for _ in range(3):
            result = run(command, log)
            if result.returncode == 0:
                break
            run(['bunx', '@actual-app/cli@latest', 'sync', '--clear'], log)
            time.sleep(2)
        else:
            print(f'failed_at {index}')
            print(f'log {log_path}')
            sys.exit(result.returncode)
        if index % 25 == 0 or index == len(updates):
            print(f'applied {index}/{len(updates)}')

print(f'done {len(updates)}')
print(f'log {log_path}')
