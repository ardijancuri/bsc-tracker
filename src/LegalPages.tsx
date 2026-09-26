import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    window.scrollTo(0, 0);
    const previousTitle = document.title;
    document.title = `${title} — bscan`;
    return () => { document.title = previousTitle; };
  }, [title]);

  return <article className="page legal-page">
    <Link className="back-link" to="/trades"><ChevronLeft size={15} aria-hidden="true" />Back to bscan</Link>
    <header className="legal-header"><span>LEGAL</span><h1>{title}</h1><p>Last updated September 26, 2026</p></header>
    <div className="legal-content">{children}</div>
  </article>;
}

export function PrivacyPolicyPage() {
  return <LegalLayout title="Privacy Policy">
    <p>bscan is a public, read-only BNB Smart Chain analytics site. You can browse it without creating an account or connecting a wallet.</p>

    <section><h2>Information shown on bscan</h2><p>We display public wallet addresses, blockchain transactions, token data, and analytics derived from them. The tracked wallet roster also contains KOL names and X handles supplied to bscan, and may include publicly available profile images. A name or handle shown beside a wallet is not independent proof of who owns it.</p></section>

    <section><h2>Information from your visit</h2><p>When you use the site, normal web requests send your IP address, browser information, requested pages, and any search terms you enter to our server. Basic request and error logs may contain this information. The current site does not use its own cookies, browser storage for tracking, or a third-party analytics script.</p></section>

    <section><h2>How we use information</h2><p>We use public data to display the trade feed, token pages, KOL profiles, and leaderboard. We use request information to deliver the site, diagnose problems, and protect the service. Where applicable, this processing supports our legitimate interest in operating and securing a public analytics service.</p></section>

    <section><h2>External services</h2><p>Some token images load from external hosts, which may receive standard request information from your browser. Links to X, BscScan, and GMGN take you to services with their own privacy practices. Our hosting provider processes information needed to deliver bscan.</p></section>

    <section><h2>Retention and your choices</h2><p>We keep indexed public blockchain data and roster information while they are needed to run the service. Operational logs are kept only as long as needed for service and security purposes. You may ask us about access, correction, or removal of off-chain profile information, or object to its use. Public blockchain records cannot be changed by bscan. Depending on where you live, you may also have a right to complain to a privacy regulator.</p></section>

    <section><h2>Contact and changes</h2><p>For privacy questions or requests, email <a href="mailto:contact@bscan.fun">contact@bscan.fun</a>. We may update this policy as the service changes; the date above shows the latest version.</p></section>
  </LegalLayout>;
}

export function TermsOfUsePage() {
  return <LegalLayout title="Terms of Use">
    <p>These terms apply to your use of bscan, a public, read-only BNB Smart Chain analytics site.</p>

    <section><h2>What the service does</h2><p>bscan displays observed transactions from a curated list of wallets, token activity, KOL profiles, and a realized profit and loss leaderboard. The site does not connect to your wallet or execute trades.</p></section>

    <section><h2>Data and limitations</h2><p>Blockchain and third-party data may be delayed, incomplete, inaccurate, or unavailable. Wallet names and X handles are not independently verified. Prices are based on observed trades, and realized profit and loss can be partial when earlier buys or reliable USD values are unavailable. Do not treat these figures as a complete account history or a live market quote.</p></section>

    <section><h2>No investment advice</h2><p>Content on bscan is for general information. It is not financial, investment, tax, or legal advice, and it is not a recommendation to buy or sell any asset. Make your own assessment before acting on the information.</p></section>

    <section><h2>Using the site</h2><p>You may use the site for lawful purposes. Do not try to disrupt the service, bypass its safeguards, or interfere with other visitors. We may change, suspend, or stop any part of bscan.</p></section>

    <section><h2>External links and availability</h2><p>Links to X, BscScan, GMGN, and other sites are provided for convenience. We do not control those services. bscan is provided as available, without a guarantee that it will be uninterrupted or error-free. To the extent permitted by law, bscan is not responsible for losses caused by reliance on the site or by third-party services.</p></section>

    <section><h2>Contact and changes</h2><p>For questions about these terms, email <a href="mailto:contact@bscan.fun">contact@bscan.fun</a>. We may revise these terms; the date above shows the latest version.</p></section>
  </LegalLayout>;
}
