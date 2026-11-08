import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, BookOpen, ChevronDown, CircleHelp, Download, Info, ScanSearch, ShieldCheck, TrendingUp, Wallet, type LucideIcon } from 'lucide-react';
import { guideTopics, type GuideSection } from './extensionGuideContent';
import './extensionGuide.css';

const topicIcons: Record<string, LucideIcon> = {
  start: BookOpen,
  gmgn: ScanSearch,
  x: TrendingUp,
  wallets: Wallet,
  trading: ArrowLeftRight,
  privacy: ShieldCheck,
  help: CircleHelp,
};

const sectionId = (topic: string, section: string) => `extension-guide-${topic}-${section}`;

function GuideSectionContent({ topic, section }: { topic: string; section: GuideSection }) {
  return <section className="extension-guide-section" id={sectionId(topic, section.id)} tabIndex={-1}>
    <h3>{section.title}</h3>
    <div className={section.image ? 'extension-guide-section-with-image' : undefined}>
      <div className="extension-guide-copy">
        {section.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        {section.steps && <ol>{section.steps.map(step => <li key={step}>{step}</li>)}</ol>}
        {section.bullets && <ul>{section.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}</ul>}
        {section.note && <aside className="extension-guide-note">
          <Info size={17} aria-hidden="true" />
          <div><strong>{section.note.title}</strong><p>{section.note.text}</p></div>
        </aside>}
      </div>
      {section.image && <figure className="extension-guide-image">
        <img src={`/extension-guide/${section.image.file}`} alt={section.image.alt} width={section.image.width} height={section.image.height} loading="lazy" />
        <figcaption>{section.image.caption}</figcaption>
      </figure>}
    </div>
  </section>;
}

export default function ExtensionGuide() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const article = useRef<HTMLElement>(null);
  const focusAfterClosing = useRef<{ topic: string; section?: string } | null>(null);
  const [collapsedTopic, setCollapsedTopic] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const target = location.hash === '#extension-install' ? sectionId('start', 'install') : location.hash.slice(1);
  const active = guideTopics.find(topic => topic.sections.some(section => sectionId(topic.id, section.id) === target))
    ?? guideTopics.find(topic => topic.id === params.get('tab'))
    ?? guideTopics[0];

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Kollens Companion Guide — kollens';
    if (!window.location.hash) window.scrollTo(0, 0);
    return () => { document.title = previousTitle; };
  }, []);

  useEffect(() => {
    const section = target.startsWith('extension-guide-') ? document.getElementById(target) : null;
    if (section) {
      section.scrollIntoView({ block: 'start' });
    } else if (article.current) {
      const { top } = article.current.getBoundingClientRect();
      const offset = Number.parseFloat(getComputedStyle(article.current).scrollMarginTop);
      if (top < offset || top > window.innerHeight) article.current.scrollIntoView({ block: 'start' });
    }
  }, [active.id, target]);

  useEffect(() => {
    const pending = focusAfterClosing.current;
    if (mobileOpen || !pending || pending.topic !== active.id || (pending.section && pending.section !== target)) return;
    focusAfterClosing.current = null;
    const section = pending.section ? document.getElementById(pending.section) : null;
    (section ?? article.current)?.focus({ preventScroll: true });
  }, [active.id, mobileOpen, target]);

  function closeMobileMenu(topic: string, section?: string) {
    if (!mobileOpen) return;
    focusAfterClosing.current = { topic, section };
    setMobileOpen(false);
  }

  function selectTopic(topic: string) {
    if (topic === active.id) {
      setCollapsedTopic(collapsedTopic === location.key ? null : location.key);
      return;
    }
    setCollapsedTopic(null);
    closeMobileMenu(topic);
    setParams(topic === guideTopics[0].id ? {} : { tab: topic });
  }

  return <div className="page extension-guide-page">
    <header className="extension-guide-hero">
      <div>
        <h1>Kollens Companion</h1>
        <p>Set up Companion, follow BNB Smart Chain activity on GMGN and X, and learn how the extension handles your wallet and data.</p>
      </div>
      <div className="extension-guide-download">
        <a className="extension-guide-download-button" href="/downloads/kollens-companion.zip" download>
          <Download size={17} aria-hidden="true" /> Download for Chrome
        </a>
        <span>ZIP download · Desktop Chrome 127 or newer</span>
      </div>
    </header>

    <div className="extension-guide-layout">
      <aside className="extension-guide-sidebar" data-mobile-open={mobileOpen}>
        <button type="button" className="extension-guide-mobile-toggle" aria-expanded={mobileOpen} aria-controls="extension-guide-navigation" onClick={() => setMobileOpen(!mobileOpen)}>
          <BookOpen size={16} aria-hidden="true" />
          <span>Guide topics</span>
          <span className="extension-guide-mobile-current">{active.label}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <div className="extension-guide-navigation" id="extension-guide-navigation">
          <p className="extension-guide-sidebar-label">Extension guide</p>
          <nav aria-label="Extension guide topics">
            {guideTopics.map(topic => {
              const Icon = topicIcons[topic.id] ?? BookOpen;
              const selected = topic.id === active.id;
              const expanded = selected && collapsedTopic !== location.key;
              const linksId = `extension-guide-links-${topic.id}`;
              return <div key={topic.id}>
                <button type="button" className="extension-guide-topic" aria-current={selected ? 'page' : undefined} aria-controls={linksId} aria-expanded={expanded} onClick={() => selectTopic(topic.id)}>
                  <Icon size={17} aria-hidden="true" />
                  <span>{topic.label}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                <ul className="extension-guide-section-links" id={linksId} hidden={!expanded}>
                  {topic.sections.map(section => {
                    const id = sectionId(topic.id, section.id);
                    return <li key={section.id}><Link
                      to={{ pathname: location.pathname, search: topic.id === guideTopics[0].id ? '' : `?tab=${topic.id}`, hash: `#${id}` }}
                      aria-current={target === id ? 'location' : undefined}
                      onClick={() => closeMobileMenu(topic.id, id)}
                    >{section.title}</Link></li>;
                  })}
                </ul>
              </div>;
            })}
          </nav>
          <div className="extension-guide-help">
            <Link to="/privacy-policy">Privacy policy</Link>
            <a href="mailto:contact@kollens.com">Contact support</a>
          </div>
        </div>
      </aside>
      <article className="extension-guide-article" ref={article} aria-labelledby="extension-guide-topic-title" tabIndex={-1}>
        <header><h2 id="extension-guide-topic-title">{active.label}</h2><p>{active.intro}</p></header>
        {active.sections.map(section => <GuideSectionContent key={`${active.id}-${section.id}`} topic={active.id} section={section} />)}
      </article>
    </div>
  </div>;
}
