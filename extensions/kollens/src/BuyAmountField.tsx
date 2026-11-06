import { Check, Pencil, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

interface BuyAmountFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  presets: readonly string[];
  onSavePresets?: (values: readonly string[]) => Promise<boolean>;
  disabled?: boolean;
  required?: boolean;
}

export function BuyAmountField({ label, value, onChange, presets, onSavePresets, disabled, required }: BuyAmountFieldProps) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editorDisabled = disabled || saving;

  function closeEditor() {
    setDraft(null);
    setError('');
  }

  async function savePresets() {
    if (!draft || !onSavePresets || editorDisabled) return;
    setSaving(true);
    setError('');
    try {
      if (await onSavePresets(draft)) closeEditor();
      else setError('Enter four different positive BNB amounts with up to 18 decimal places.');
    } catch {
      setError('Could not save these presets. Try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleEditorKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void savePresets();
    } else if (event.key === 'Escape' && !editorDisabled) {
      event.preventDefault();
      closeEditor();
    }
  }

  return <div>
    <label>{label}
      <input inputMode="decimal" value={value} onChange={event => onChange(event.target.value)}
        disabled={disabled} required={required}/>
    </label>
    <div className="buy-amount-preset-row" role="group" aria-label={`${label} presets`}>
      {draft ? <div className="buy-amount-preset-editor">
        {draft.map((preset, index) => <input key={index} inputMode="decimal" aria-label={`Preset ${index + 1} (BNB)`}
          autoFocus={index === 0} value={preset} disabled={editorDisabled} onKeyDown={handleEditorKey}
          onChange={event => {
            const amount = event.target.value;
            setDraft(current => current?.map((entry, position) => position === index ? amount : entry) ?? null);
            setError('');
          }}/>)}
        <div className="buy-amount-preset-actions">
          <button type="button" aria-label="Save presets" title="Save presets" disabled={editorDisabled} onClick={() => void savePresets()}>
            <Check size={14} aria-hidden="true"/>
          </button>
          <button type="button" aria-label="Cancel preset edits" title="Cancel preset edits" disabled={editorDisabled} onClick={closeEditor}>
            <X size={14} aria-hidden="true"/>
          </button>
        </div>
      </div> : <>
        <div className="buy-amount-presets">
          {presets.map(preset => <button key={preset} className="popup-action secondary" type="button"
            aria-label={`${preset} BNB`} title={`${preset} BNB`}
            data-selected={value === preset || undefined} disabled={disabled} onClick={() => onChange(preset)}>
            <span>{preset}</span><img src="assets/bnb-chain.svg" alt="" width="11" height="11"/>
          </button>)}
        </div>
        {onSavePresets && <div className="buy-amount-preset-actions">
          <button type="button" aria-label="Edit presets" title="Edit presets" disabled={disabled} onClick={() => setDraft([...presets])}>
            <Pencil size={13} aria-hidden="true"/>
          </button>
        </div>}
      </>}
    </div>
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </div>;
}
