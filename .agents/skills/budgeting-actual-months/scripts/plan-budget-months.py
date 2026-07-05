#!/usr/bin/env python3
import argparse
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

DB_ROOT = Path('.actual-cache')
DEFAULT_FIRST_HOLD = 2_000_000_00


def cents(value):
    return f"Rp{value / 100:,.2f}"


def month_int(month):
    return int(month.replace('-', ''))


def bounds(month):
    ym = month.replace('-', '')
    return int(ym + '01'), int(ym + '31')


def parse_cli_json(output):
    match = re.search(r'(?m)^(\{|\[)', output)
    if not match:
        raise ValueError(output)
    return json.loads(output[match.start():])


def run_cli(args):
    cmd = ['bunx', '@actual-app/cli@latest', '--lock-timeout', '120', *args, '--format', 'json']
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        sys.stderr.write(result.stdout)
        raise SystemExit(result.returncode)
    return parse_cli_json(result.stdout)


def db_path():
    matches = list(DB_ROOT.glob('*/db.sqlite'))
    if len(matches) != 1:
        raise SystemExit('Expected exactly one .actual-cache/*/db.sqlite. Sync canonical cache first.')
    return matches[0]


def categories(con):
    rows = con.execute('''
        select id, name
        from categories
        where tombstone = 0 and is_income = 0 and hidden = 0
        order by sort_order
    ''').fetchall()
    return {row['id']: row['name'] for row in rows}


def desired_spend(con, month, category_names):
    start, end = bounds(month)
    rows = con.execute('''
        select c.id, coalesce(sum(t.amount), 0) amount
        from categories c
        left join transactions t
          on t.category = c.id
         and t.tombstone = 0
         and t.isParent = 0
         and t.date between ? and ?
        left join accounts a on a.id = t.acct
        where c.tombstone = 0
          and c.is_income = 0
          and c.hidden = 0
          and (a.offbudget = 0 or a.offbudget is null)
        group by c.id
    ''', (start, end)).fetchall()
    return {row['id']: max(0, -int(row['amount'] or 0)) for row in rows if row['id'] in category_names}


def current_amounts(budget):
    amounts = {}
    for group in budget['categoryGroups']:
        if group.get('is_income'):
            continue
        for category in group['categories']:
            if 'budgeted' in category:
                amounts[category['id']] = int(category['budgeted'])
    return amounts


def set_amount(month, category, amount, apply):
    if apply:
        run_cli(['budgets', 'set-amount', '--month', month, '--category', category, '--amount', str(amount)])


def reset_hold(month, apply):
    if apply:
        run_cli(['budgets', 'reset-hold', '--month', month])


def hold_next(month, amount, apply):
    if apply and amount:
        run_cli(['budgets', 'hold-next-month', '--month', month, '--amount', str(amount)])


def plan_month(con, month, category_names, apply, first_month, first_hold):
    budget = run_cli(['budgets', 'month', month])
    desired = desired_spend(con, month, category_names)
    emergency = next((cid for cid, name in category_names.items() if 'Emergency Fund' in name), None)
    if emergency:
        desired[emergency] = 0

    hold = first_hold if first_month else 0
    current = current_amounts(budget)

    reset_hold(month, apply)
    hold_next(month, hold, apply)
    for cid, amount in sorted(desired.items(), key=lambda item: category_names[item[0]]):
        if current.get(cid, 0) != amount:
            set_amount(month, cid, amount, apply)

    budget = run_cli(['budgets', 'month', month]) if apply else budget
    to_budget = int(budget['toBudget'])
    if not first_month:
        hold = to_budget if to_budget > 0 else 0
        reset_hold(month, apply)
        hold_next(month, hold, apply)
    elif emergency and to_budget > 0:
        set_amount(month, emergency, current_amounts(budget).get(emergency, 0) + to_budget, apply)

    final = run_cli(['budgets', 'month', month]) if apply else budget
    print(f"\n{month}")
    print(f"  To Budget: {cents(final['toBudget'])}" + (' after apply' if apply else ' before apply'))
    shown_hold = final['forNextMonth'] if not apply else hold
    print(f"  For next month: {cents(shown_hold)}")
    for cid, amount in sorted(desired.items(), key=lambda item: category_names[item[0]]):
        if amount:
            print(f"  {category_names[cid]}: {cents(amount)}")
    if apply and final['toBudget'] != 0:
        raise SystemExit(f'{month} still has To Budget {cents(final["toBudget"])}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--months', nargs='+', required=True, help='Months like 2026-05')
    parser.add_argument('--apply', action='store_true', help='Apply approved budget changes through Actual CLI')
    parser.add_argument('--first-hold', type=int, default=DEFAULT_FIRST_HOLD, help='Cents to hold for next month in the first month')
    args = parser.parse_args()

    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    category_names = categories(con)
    for index, month in enumerate(args.months):
        plan_month(con, month, category_names, args.apply, first_month=index == 0, first_hold=args.first_hold)


if __name__ == '__main__':
    main()
