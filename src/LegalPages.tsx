import { t, useLanguage } from './i18n';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  const [language] = useLanguage();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `${t(title)} — bscan`;
    return () => { document.title = t('bscan — BSC KOL tracker'); };
  }, [title, language]);

  return <article className="page legal-page">
    <Link className="back-link" to="/trades"><ChevronLeft size={15} aria-hidden="true" />{t("Back to bscan")}</Link>
    <header className="legal-header"><span>{t("LEGAL")}</span><h1>{t(title)}</h1><p>{t("Last updated October 3, 2026")}</p></header>
    <div className="legal-content">{children}</div>
  </article>;
}

export function PrivacyPolicyPage() {
  return <LegalLayout title={t("Privacy Policy")}>
    <p>{t("bscan is a public, read-only BNB Smart Chain analytics site. You can browse it without creating an account or connecting a wallet.")}</p>

    <section><h2>{t("Information shown on bscan")}</h2><p>{t("We display public wallet addresses, blockchain transactions, token data, and analytics derived from them. The tracked wallet roster also contains KOL names and X handles supplied to bscan, and may include publicly available profile images. A name or handle shown beside a wallet is not independent proof of who owns it.")}</p></section>

    <section><h2>{t("Information from your visit")}</h2><p>{t("When you use the site, normal web requests send your IP address, browser information, requested pages, and any search terms you enter to our server. Basic request and error logs may contain this information. Browsing does not require an account. If you save a watchlist, we set an essential, secure HttpOnly cookie to recognize that browser. We do not use a third-party analytics script.")}</p></section>

    <section><h2>{t('Language preference')}</h2><p>{t('Your language choice is saved in this browser’s local storage.')}</p></section>

    <section><h2>{t("Watchlists and Telegram")}</h2><p>{t("We store followed wallet and token addresses, alert settings, and a hashed browser-session secret. Watchlists belong to the browser that created them. If you choose to connect Telegram and confirm in that browser, we store your Telegram chat identifier and available username to send the alerts you selected. We record delivery attempts to avoid duplicate alerts and diagnose failures. Telegram processes messages under its own privacy practices.")}</p><p>{t("You can mute or disconnect Telegram in Watchlist settings, or send /stop to the bot. Clear watchlist deletes your saved preferences, Telegram connection, and delivery records. Browser sessions expire after up to a year without a save; linking codes expire after ten minutes and their records are removed after a day. Webhook update identifiers are kept for seven days to prevent duplicates. Clearing browser cookies loses access to that watchlist; cross-device recovery is unavailable.")}</p></section>

    <section><h2>{t("How we use information")}</h2><p>{t("We use public data to display the trade feed, token pages, KOL profiles, and leaderboard. We use request information to deliver the site, diagnose problems, and protect the service. Where applicable, this processing supports our legitimate interest in operating and securing a public analytics service.")}</p></section>

    <section><h2>{t("External services")}</h2><p>{t("Some token images load from external hosts, which may receive standard request information from your browser. Links to X, BscScan, and GMGN take you to services with their own privacy practices. Our hosting provider processes information needed to deliver bscan. We send public token names to MyMemory to provide cached English translations; these requests do not include your browser identifiers or watchlist.")}</p></section>

    <section><h2>{t("Retention and your choices")}</h2><p>{t("We keep indexed public blockchain data and roster information while they are needed to run the service. Operational logs are kept only as long as needed for service and security purposes. You may ask us about access, correction, or removal of off-chain profile information, or object to its use. Public blockchain records cannot be changed by bscan. Depending on where you live, you may also have a right to complain to a privacy regulator.")}</p></section>

    <section><h2>{t("Contact and changes")}</h2><p>{t("For privacy questions or requests, email")}{' '}<a href="mailto:contact@bscan.fun">contact@bscan.fun</a>{t(". We may update this policy as the service changes; the date above shows the latest version.")}</p></section>
  </LegalLayout>;
}

export function TermsOfUsePage() {
  return <LegalLayout title={t("Terms of Use")}>
    <p>{t("These terms apply to your use of bscan, a public, read-only BNB Smart Chain analytics site.")}</p>

    <section><h2>{t("What the service does")}</h2><p>{t("bscan displays observed transactions from a curated list of wallets, token activity, KOL profiles, and a realized profit and loss leaderboard. The site does not connect to your wallet or execute trades.")}</p></section>

    <section><h2>{t("Data and limitations")}</h2><p>{t("Blockchain and third-party data may be delayed, incomplete, inaccurate, or unavailable. Wallet names and X handles are not independently verified. Prices are based on observed trades, and realized profit and loss can be partial when earlier buys or reliable USD values are unavailable. Do not treat these figures as a complete account history or a live market quote.")}</p></section>

    <section><h2>{t("No investment advice")}</h2><p>{t("Content on bscan is for general information. It is not financial, investment, tax, or legal advice, and it is not a recommendation to buy or sell any asset. Make your own assessment before acting on the information.")}</p></section>

    <section><h2>{t("Using the site")}</h2><p>{t("You may use the site for lawful purposes. Do not try to disrupt the service, bypass its safeguards, or interfere with other visitors. We may change, suspend, or stop any part of bscan.")}</p></section>

    <section><h2>{t("External links and availability")}</h2><p>{t("Links to X, BscScan, GMGN, and other sites are provided for convenience. We do not control those services. bscan is provided as available, without a guarantee that it will be uninterrupted or error-free. To the extent permitted by law, bscan is not responsible for losses caused by reliance on the site or by third-party services.")}</p></section>

    <section><h2>{t("Contact and changes")}</h2><p>{t("For questions about these terms, email")}{' '}<a href="mailto:contact@bscan.fun">contact@bscan.fun</a>{t(". We may revise these terms; the date above shows the latest version.")}</p></section>
  </LegalLayout>;
}
