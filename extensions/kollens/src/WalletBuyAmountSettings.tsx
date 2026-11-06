import { useEffect, useState, type FormEvent } from 'react';
import { BuyAmountField } from './BuyAmountField';
import {
  defaultWalletBuyDestination, defaultWalletBuyMaxFeeBnb, defaultWalletBuyPresets, defaultWalletBuySlippageBps,
  loadWalletBuySettings, parseWalletBuySlippage, saveWalletBuyPresets, saveWalletBuySettings,
  type WalletBuyAmounts, type WalletBuyDestination, type WalletBuyMode, type WalletBuyPresets,
  type WalletBuySettings, type WalletBuySlippage,
} from './walletBuyDefaults';
import { maxWalletBuySlippageBps, walletBuyErrorMessage } from './walletSwap';
import './walletBuySettings.css';

const buyModes = [
  { mode: 'single', amountLabel: 'Single token (BNB per wallet)', slippageLabel: 'Single-token slippage (%)' },
  { mode: 'group', amountLabel: 'Group buy (BNB per token, per wallet)', slippageLabel: 'Group-buy slippage (%)' },
] as const;

type EditableBuySettings = Omit<WalletBuySettings, 'presets'>;

interface BuySettingsDraft {
  amounts: WalletBuyAmounts;
  slippage: Record<WalletBuyMode, string>;
  maxFeeBnb: string;
  singleTokenDestination: WalletBuyDestination;
}

function toDraft(settings: EditableBuySettings): BuySettingsDraft {
  return {
    amounts: settings.amounts,
    slippage: {
      single: String(settings.slippageBps.single / 100),
      group: String(settings.slippageBps.group / 100),
    },
    maxFeeBnb: settings.maxFeeBnb,
    singleTokenDestination: settings.singleTokenDestination,
  };
}

export function WalletBuyAmountSettings() {
  const [saved, setSaved] = useState<EditableBuySettings | null>(null);
  const [draft, setDraft] = useState<BuySettingsDraft>(() => toDraft({
    amounts: { single: '', group: '' },
    slippageBps: { single: defaultWalletBuySlippageBps, group: defaultWalletBuySlippageBps },
    maxFeeBnb: defaultWalletBuyMaxFeeBnb,
    singleTokenDestination: defaultWalletBuyDestination,
  }));
  const [presets, setPresets] = useState<WalletBuyPresets>({ single: defaultWalletBuyPresets, group: defaultWalletBuyPresets });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let active = true;
    void loadWalletBuySettings().then(settings => {
      if (!active) return;
      setSaved(settings);
      setDraft(toDraft(settings));
      setPresets(settings.presets);
    }).catch(() => {
      if (active) setError('Could not load your buy settings. Reopen Settings to try again.');
    });
    return () => { active = false; };
  }, []);

  function edit(update: (current: BuySettingsDraft) => BuySettingsDraft) {
    setDraft(update);
    setSuccess(false);
    setError('');
  }

  async function savePresets(mode: WalletBuyMode, values: readonly string[]) {
    const updated = await saveWalletBuyPresets(mode, values);
    if (!updated) return false;
    setPresets(current => ({ ...current, [mode]: updated }));
    return true;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved || busy) return;
    setError('');
    setSuccess(false);
    const single = parseWalletBuySlippage(draft.slippage.single);
    const group = parseWalletBuySlippage(draft.slippage.group);
    if (single === null || group === null) {
      const label = single === null ? 'single-token' : 'group-buy';
      setError(`Enter ${label} slippage from 0.01% to ${maxWalletBuySlippageBps / 100}% with up to two decimal places.`);
      return;
    }
    const settings: EditableBuySettings = {
      amounts: { single: draft.amounts.single.trim(), group: draft.amounts.group.trim() },
      slippageBps: { single, group },
      maxFeeBnb: draft.maxFeeBnb.trim(),
      singleTokenDestination: draft.singleTokenDestination,
    };
    const amounts: Partial<WalletBuyAmounts> = {};
    const slippageBps: Partial<WalletBuySlippage> = {};
    for (const { mode } of buyModes) {
      if (settings.amounts[mode] !== saved.amounts[mode]) amounts[mode] = settings.amounts[mode];
      if (settings.slippageBps[mode] !== saved.slippageBps[mode]) slippageBps[mode] = settings.slippageBps[mode];
    }
    setBusy(true);
    try {
      await saveWalletBuySettings({
        amounts,
        slippageBps,
        maxFeeBnb: settings.maxFeeBnb !== saved.maxFeeBnb ? settings.maxFeeBnb : undefined,
        singleTokenDestination: settings.singleTokenDestination !== saved.singleTokenDestination
          ? settings.singleTokenDestination : undefined,
      });
      const updated = await loadWalletBuySettings().catch(() => settings);
      setSaved(updated);
      setDraft(toDraft(updated));
      setSuccess(true);
    } catch (failure) {
      setError(walletBuyErrorMessage(failure, 'Could not save your buy settings.'));
    } finally {
      setBusy(false);
    }
  }

  const disabled = !saved || busy;
  return <section className="settings-group wallet-editor buy-amount-settings" aria-label="Buy settings">
    <h2>Buy settings</h2>
    <p>Buy buttons use these amounts. Set an amount to enable that buy mode.</p>
    <form onSubmit={event => void save(event)}>
      {buyModes.map(({ mode, amountLabel, slippageLabel }) => <div className="buy-settings-mode" key={mode}>
        <BuyAmountField label={amountLabel} value={draft.amounts[mode]} disabled={disabled}
          presets={presets[mode]} onChange={value => edit(current => ({
            ...current, amounts: { ...current.amounts, [mode]: value },
          }))} onSavePresets={values => savePresets(mode, values)}/>
        <label className="buy-setting-inline">{slippageLabel}
          <input inputMode="decimal" value={draft.slippage[mode]} disabled={disabled} onChange={event => {
            const value = event.target.value;
            edit(current => ({ ...current, slippage: { ...current.slippage, [mode]: value } }));
          }}/>
        </label>
      </div>)}
      <label className="buy-setting-inline">Max network fee per buy (BNB)
        <input inputMode="decimal" value={draft.maxFeeBnb} disabled={disabled} onChange={event => {
          const maxFeeBnb = event.target.value;
          edit(current => ({ ...current, maxFeeBnb }));
        }}/>
      </label>
      <label className="buy-setting-inline buy-destination-setting">Open GMGN after single buy
        <select value={draft.singleTokenDestination} disabled={disabled} onChange={event => {
          const singleTokenDestination = event.currentTarget.value === 'new-tab' ? 'new-tab' : 'same-tab';
          edit(current => ({ ...current, singleTokenDestination }));
        }}>
          <option value="same-tab">Same tab</option>
          <option value="new-tab">New tab</option>
        </select>
      </label>
      {error && <p className="wallet-error" role="alert">{error}</p>}
      {success && <p role="status">Buy settings saved.</p>}
      <button className="popup-action" type="submit" disabled={disabled}>Save buy settings</button>
    </form>
  </section>;
}
