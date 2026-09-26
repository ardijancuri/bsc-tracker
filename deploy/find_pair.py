"""Find a recent tracked token-to-token swap for RPC verification."""
import json
import urllib.request

RPC = 'http://127.0.0.1:8545'
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'


def rpc(method, params):
    request = urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)['result']


with urllib.request.urlopen('http://127.0.0.1:3300/api/trades?limit=100', timeout=10) as response:
    trades = json.load(response)['items']

seen = set()
for trade in trades:
    tx_hash = trade['txHash']
    if tx_hash in seen:
        continue
    seen.add(tx_hash)
    tx = rpc('eth_getTransactionByHash', [tx_hash])
    if not tx or int(tx['value'], 16) != 0:
        continue
    receipt = rpc('eth_getTransactionReceipt', [tx_hash])
    if not receipt or receipt['status'] != '0x1':
        continue
    wallet = tx['from'].lower()
    flows = {}
    for log in receipt['logs']:
        topics = log['topics']
        if len(topics) < 3 or topics[0].lower() != TRANSFER:
            continue
        sender, receiver = '0x' + topics[1][-40:].lower(), '0x' + topics[2][-40:].lower()
        token = log['address'].lower()
        amount = int(log['data'], 16)
        if sender == wallet:
            flows[token] = flows.get(token, 0) - amount
        if receiver == wallet:
            flows[token] = flows.get(token, 0) + amount
    if any(value < 0 for value in flows.values()) and any(value > 0 for value in flows.values()):
        print(json.dumps({'hash': tx_hash, 'wallet': wallet, 'block': int(tx['blockNumber'], 16), 'flows': flows}))
        break
