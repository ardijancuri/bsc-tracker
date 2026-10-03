import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chinese } from './zh-CN';
import { translate, validLanguage } from './i18n';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('Chinese app language', () => {
  it('translates labels and interpolates counts without changing token identities', () => {
    expect(translate('Trades', 'zh-CN')).toBe('交易');
    expect(translate('{count} KOLs · {minutes}m', 'zh-CN', { count: 3, minutes: 10 })).toBe('3 个 KOL · 10 分钟');
    expect(translate('{action} {name}', 'zh-CN', { action: '关注', name: 'professor' })).toBe('关注 professor');
    expect(translate('Trades', 'en')).toBe('Trades');
    expect(translate('Custom token name', 'zh-CN')).toBe('Custom token name');
    expect(translate('{count} KOLs · {minutes}m', 'en', { count: 3, minutes: 10 })).toBe('3 KOLs · 10m');
    expect(validLanguage('unsupported')).toBe('en');
  });
  it('preserves every interpolation parameter in Chinese, including legal and alert copy', () => {
    for (const [english, translated] of Object.entries(chinese)) {
      expect(translated.trim(), english).not.toBe('');
      expect(translated.match(/\{\w+\}/g)?.sort() || [], english).toEqual(english.match(/\{\w+\}/g)?.sort() || []);
      expect(translated, english).not.toMatch(/[<>]/);
    }
  });
  it('covers every static translation used in the UI', () => {
    for (const file of ['App.tsx', 'Intelligence.tsx', 'LegalPages.tsx', 'LanguageSelect.tsx', 'lib.ts']) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const walk = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) expect(chinese, `${file}: ${node.arguments[0].text}`).toHaveProperty(node.arguments[0].text);
        ts.forEachChild(node, walk);
      };
      walk(source);
    }
  });
  it('saves language and restores it on reload, without depending on accessible storage', async () => {
    const saved = new Map<string, string>();
    const fakeWindow = { localStorage: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) }, addEventListener: vi.fn() };
    vi.stubGlobal('window', fakeWindow);
    vi.resetModules();
    let language = await import('./i18n');
    language.setLanguage('zh-CN');
    expect(saved.get('bscan-language')).toBe('zh-CN');
    vi.resetModules(); language = await import('./i18n');
    expect(language.getLanguage()).toBe('zh-CN');
    expect(language.getLocale()).toBe('zh-CN');
    fakeWindow.localStorage.setItem = () => { throw new Error('Storage disabled'); };
    expect(() => language.setLanguage('en')).not.toThrow();
    expect(language.t('Trades')).toBe('Trades');
  });
  it('follows language changes from another tab and formats Chinese relative time', async () => {
    let stored = 'en'; let listener: (event: { key: string | null }) => void = () => {};
    vi.stubGlobal('window', { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } }, addEventListener: (_event: string, callback: typeof listener) => { listener = callback; } });
    vi.resetModules(); const language = await import('./i18n');
    stored = 'zh-CN'; listener({ key: 'bscan-language' });
    expect(language.getLanguage()).toBe('zh-CN');
    const { relativeTime, compact } = await import('./lib');
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toBe('2 分钟前');
    expect(compact(12_000, true)).toContain('万');
    stored = 'en'; listener({ key: null });
    expect(relativeTime(new Date(Date.now() - 120_000).toISOString())).toBe('2m ago');
  });
});
