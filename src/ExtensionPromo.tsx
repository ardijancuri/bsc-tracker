import { useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { t } from './i18n';
import './extensionPromo.css';

export function ExtensionDownloadLink() {
  return <a className="extension-promo-download" href="/downloads/kollens-companion.zip" download>
    <Download size={16} aria-hidden="true" />{t('Download for Chrome')}
  </a>;
}

export function ExtensionInstallSteps({ id, className, hidden }: { id?: string; className?: string; hidden?: boolean }) {
  return <ol id={id} className={className} hidden={hidden}>
    <li>{t('Download and extract the ZIP file.')}</li>
    <li>{t('In desktop Chrome, open chrome://extensions and turn on Developer mode.')}</li>
    <li>{t('Click Load unpacked and select the extracted folder containing manifest.json.')}</li>
    <li>{t('Open GMGN BNB Trenches, then select Tokens in Kollens Companion.')}</li>
  </ol>;
}

export function ExtensionPromo() {
  const [guideOpen, setGuideOpen] = useState(false);

  return <section className="extension-promo" aria-labelledby="extension-promo-title">
    <div className="extension-promo-body">
      <div className="extension-promo-copy">
        <span className="extension-promo-label">{t('Desktop Chrome extension')}</span>
        <h2 id="extension-promo-title">Kollens Companion</h2>
        <p>{t('Find related tokens in GMGN BNB Trenches, manage wallets, and trade from Chrome.')}</p>
        <div className="extension-promo-actions">
          <ExtensionDownloadLink />
          <button className="extension-promo-install" type="button" aria-expanded={guideOpen} aria-controls="extension-install-guide"
            onClick={() => setGuideOpen(open => !open)}>
            {t('How to install')}<ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <img className="extension-promo-preview" src="/kollens-companion-preview.webp?v=gm-safu" width={360} height={224} decoding="async"
        alt={t('Green Morning and SAFU in the Kollens Companion Saved tab')} />
    </div>
    <ExtensionInstallSteps id="extension-install-guide" className="extension-promo-guide" hidden={!guideOpen} />
  </section>;
}
