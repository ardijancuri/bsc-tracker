export function journalCoverageNotice(reasons: string[]) {
  if (reasons.some(value => /balance|internal_transfer/.test(value))) return 'Wallet movements still need reconciliation.';
  if (reasons.some(value => /cost_unknown|shared_quote/.test(value))) return 'Earlier purchase or transfer costs are unavailable.';
  if (reasons.some(value => /fees|fee_/.test(value))) return 'Some wallet-paid fees are unavailable.';
  if (reasons.some(value => /quote/.test(value))) return 'Waiting for a current token price.';
  if (reasons.some(value => /order/.test(value))) return 'Some historical execution ordering is unknown.';
  return 'History is still preparing or incomplete.';
}
