import { useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { gmgnNarrativeOrigin, type GmgnNarrative } from './gmgnNarrative';
import { browserApi, requestBackground } from './platform';

const unavailableMessages = {
  unavailable: 'No AI summary available for this token.',
  page_unavailable: 'Could not load the AI summary. Reopen to try again.',
  busy: 'Another summary is loading. Reopen in a moment.',
  access_required: 'Allow site access in Chrome to show the AI summary.',
  group_changed: 'The token changed. Reopen to try again.',
};

export function GroupNarrative({ groupId, address, windowId, origin = gmgnNarrativeOrigin }: {
  groupId?: string;
  address: string;
  windowId?: number;
  origin?: typeof gmgnNarrativeOrigin | 'https://www.gmgn.ai/*';
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const [narrative, setNarrative] = useState<GmgnNarrative | null>(null);

  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setNarrative(null);
    try {
      // Chrome must see the opening click as the permission gesture.
      const allowed = await browserApi.permissions.request({ origins: [origin] });
      const result = allowed ? await requestBackground<GmgnNarrative>({ kind: 'gmgn/narrative', address, groupId, windowId })
        : { status: 'access_required' } as const;
      setNarrative(result);
    } catch {
      setNarrative({ status: 'page_unavailable' });
    } finally {
      pending.current = false;
    }
  };

  return <details className="group-narrative" name="gmgn-narratives" ref={disclosure} onKeyDown={event => {
    if (event.key === 'Escape' && disclosure.current?.open) {
      disclosure.current.open = false;
      trigger.current?.focus();
      event.stopPropagation();
    }
  }}>
    <summary className="source-link" title="AI summary" aria-label="AI summary" ref={trigger} onClick={() => {
      if (!disclosure.current?.open) void load();
    }}>
      <Sparkles className="ui-icon" size={15} strokeWidth={1.7} aria-hidden="true" />
    </summary>
    <div className="group-narrative-popover">
      <strong className="group-narrative-title">
        <Sparkles className="ui-icon" size={13} strokeWidth={1.7} aria-hidden="true" />
        AI summary
      </strong>
      <div aria-live="polite">
        {narrative?.status === 'ready' ? <>
          <p className="group-narrative-text">{narrative.text}</p>
          <p className="group-narrative-credit">AI-generated. Verify before investing.</p>
        </> : <p>{narrative ? unavailableMessages[narrative.status] : 'Loading summary…'}</p>}
      </div>
    </div>
  </details>;
}
