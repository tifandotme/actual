#!/usr/bin/env python3
import json
import re
from collections import defaultdict
from pathlib import Path

root = Path('.categorize/latest')
rows = json.loads((root / 'uncategorized.json').read_text())
categories = {
    c['name']: c['id']
    for c in json.loads((root / 'categories.json').read_text())
    if not c.get('hidden')
}

keywords = [
    ('🥡 Delivery', r'grab|gofood|gobiz|shopeefood|delivery'),
    ('🍽️ Dining/Takeout', r'rest|restaurant|cafe|coffee|kopi|starbucks|sbux|mcd|kfc|pizza|bakery|sushi|ramen|warung|waroeng|warkop|warsun|ayam|mie|bakmi|nasi|nasgor|soto|bakso|siomay|telor|cilok|pecel|martabak|sate|rawon|hokben|hhb|tomoro|upnormal|yoshinoya|lawson|kantin|dapur|puyo|dessert|thai tea|drink|food|eat|dining'),
    ('🥬 Groceries', r'super|market|mart|ranch|alfamart|indomaret|hypermart|family ?mart|fmi|midi|grocery|sayur|fresh'),
    ('🚗 Transportation', r'gojek|grab|bluebird|taxi|parking|parkir|tol|shell|pertamina|spbu|transport'),
    ('💳 Subscription & Memberships', r'netflix|spotify|apple|icloud|google|youtube|openai|anthropic|github|subscription|membership'),
    ('💡 Utilities', r'pln|pdam|telkom|telkomsel|internet|wifi|listrik|utility'),
    ('💪 Health & Wellness', r'apotek|pharma|clinic|hospital|dokter|health|gym|fitness|barber'),
    ('👕 Clothing', r'zara|uniqlo|hm|h&m|levis|clothing|sepatu|shoe'),
    ('🧺 Laundry', r'laundry'),
    ('💃 Entertainment and Fun', r'cinema|bioskop|xxi|cgv|game|steam|entertain'),
    ('🏘️ Housing', r'rent|sewa|kost|apartment|maintenance'),
    ('🛍️ Shopping and Miscellaneous', r'shopee|tokopedia|toko '),
    ('↩️ Refund', r'refund|reversal|cashback'),
]


def clean(value):
    return re.sub(r'\s+', ' ', (value or '').strip())


def group_key(value):
    value = clean(value).upper()
    value = re.sub(r'\b(QRIS|BCA|DBS|VISA|MASTERCARD|POS|EDC|ID|INV|TRX|REF|TRANSFER|PAYMENT|PEMBAYARAN)\b', ' ', value)
    value = re.sub(r'[#*:/\\|._,-]+', ' ', value)
    value = re.sub(r'\b\d{2,}\b', ' ', value)
    value = re.sub(r'\s+', ' ', value).strip()
    return value[:40] or 'UNKNOWN'


def suggest_category(text, amount):
    if not clean(text):
        return None
    if re.search(r'endang sri wijayanti', text, re.I):
        return '🛡️ Insurance'
    if re.search(r'kimsyahla|fit hub|jumpstart|camila|konter c warnas|dudung roxy|mendoan|muhammad khanafi|ngeciken|pasti tebet|pondok lesehan|queen es teler|stik kentang|yummy coin', text, re.I):
        return '🍽️ Dining/Takeout'
    if re.search(r'pajak bunga', text, re.I):
        return '% Taxes'
    if amount > 0:
        if re.search(r'\bbunga\b', text, re.I):
            return '🪙 Interests'
        return '↩️ Refund' if re.search(r'refund|reversal|cashback', text, re.I) else None
    for category, pattern in keywords:
        if re.search(pattern, text, re.I):
            return category
    if re.search(r'\b(kk|hb|dd)\b|takoyaki|smoothies|cilung|papeda', text, re.I):
        return '🍽️ Dining/Takeout'
    return None


usable = [r for r in rows if not r.get('transfer_id') and not r.get('starting_balance_flag')]
groups = defaultdict(list)
for row in usable:
    text = clean(row.get('payee.name') or row.get('imported_payee') or '')
    groups[group_key(text)].append(row)

proposal = []
updates = []
for key, items in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
    names = sorted({clean(i.get('payee.name') or i.get('imported_payee') or '') for i in items})
    target = min(names, key=lambda name: (len(name), name.lower())) if names else ''
    category = suggest_category(' '.join(names), sum(i.get('amount', 0) for i in items))
    proposal.append({
        'key': key,
        'count': len(items),
        'payees': names,
        'target_payee': target,
        'category': category,
        'total_cents': sum(i.get('amount', 0) for i in items),
        'transaction_ids': [i['id'] for i in items],
    })
    if category in categories:
        updates.extend({'id': i['id'], 'category': categories[category]} for i in items)

(root / 'proposal.json').write_text(json.dumps(proposal, indent=2, ensure_ascii=False))
(root / 'category-updates.json').write_text(json.dumps(updates, indent=2))

with (root / 'proposal.md').open('w') as file:
    file.write('# Uncategorized proposal\n\n')
    file.write(f'- Non-transfer uncategorized: {len(usable)}\n')
    file.write(f'- Auto-category candidates: {len(updates)}\n')
    file.write(f'- Manual review: {len(usable) - len(updates)}\n\n')
    file.write('| Count | Suggested category | Target payee | Variants |\n')
    file.write('|---:|---|---|---|\n')
    for group in proposal:
        variants = '<br>'.join(group['payees'][:8])
        if len(group['payees']) > 8:
            variants += f'<br>… +{len(group["payees"]) - 8} more'
        file.write(f"| {group['count']} | {group['category'] or 'REVIEW'} | {group['target_payee'] or '<blank>'} | {variants or '<blank>'} |\n")

print(f'groups {len(proposal)}')
print(f'auto_updates {len(updates)}')
print(f'manual {len(usable) - len(updates)}')
