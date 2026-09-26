"""Read-only BSC RPC diagnostic for a transaction hash."""
import json
import sys
import urllib.request

RPC = 'http://127.0.0.1:8545'
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'


def call(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    request = urllib.request.Request(RPC, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result['result']


tx = call('eth_getTransactionByHash', [sys.argv[1]])
receipt = call('eth_getTransactionReceipt', [sys.argv[1]])
if not tx or not receipt:
    print('Transaction or receipt unavailable')
    sys.exit(1)
wallet = tx['from'].lower()
transfers = []
for log in receipt['logs']:
    topics = log['topics']
    if len(topics) < 3 or topics[0].lower() != TRANSFER:
        continue
    sender = '0x' + topics[1][-40:].lower()
    receiver = '0x' + topics[2][-40:].lower()
    if wallet in (sender, receiver):
        transfers.append({'token': log['address'].lower(), 'from': sender, 'to': receiver, 'raw': int(log['data'], 16)})
print(json.dumps({'from': wallet, 'to': tx['to'], 'value': int(tx['value'], 16), 'block': int(tx['blockNumber'], 16), 'status': receipt['status'], 'walletTransfers': transfers, 'topics': list({log['topics'][0] for log in receipt['logs'] if log['topics']})}, indent=2))
