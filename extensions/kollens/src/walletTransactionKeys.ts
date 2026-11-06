export function walletTransactionLockKey(address: string): string {
  return `wallet-transfer:${address.toLowerCase()}`;
}

export function pendingWalletBuyKey(address: string): string {
  return `wallet-buy:${address.toLowerCase()}`;
}
