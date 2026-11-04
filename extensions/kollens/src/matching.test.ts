import {describe,it,expect} from 'vitest';
import {normalizeSocialLink,matchCards,groupColor} from './matching';
import {PageAlerts} from './alerts';
import {defaultExtensionPreferences,type TokenCard} from '../../../shared/extension';
const card=(n:number,urls:string[],address=n):TokenCard=>({cardId:String(n),chainId:56,address:'0x'+address.toString(16).padStart(40,'0'),name:'Token',symbol:'T',tokenUrl:'',socialLinks:urls.map(normalizeSocialLink).filter(x=>x!==null)});
describe('social destination parsing',()=>{
  it.each(['https://x.com/alice/status/2117053489755140401','https://twitter.com/bob/status/2117053489755140401?s=20','https://mobile.twitter.com/bob/status/2117053489755140401/photo/1','https://x.com/i/web/status/2117053489755140401','https://x.com/i/status/2117053489755140401'])('preserves exact large IDs: %s',url=>expect(normalizeSocialLink(url)).toMatchObject({type:'x_post',key:'2117053489755140401'}));
  it('keeps adjacent snowflakes distinct',()=>expect(normalizeSocialLink('https://x.com/a/status/2117053489755140402')?.key).not.toBe(normalizeSocialLink('https://x.com/a/status/2117053489755140401')?.key));
  it.each(['https://x.com/Alice?utm_source=token','http://twitter.com/alice/'])('normalizes explicit profile: %s',url=>expect(normalizeSocialLink(url)).toMatchObject({type:'x_profile',key:'alice'}));
  it('normalizes communities independently',()=>expect(normalizeSocialLink('https://twitter.com/i/communities/2117053489755140401')).toMatchObject({type:'x_community',key:'2117053489755140401'}));
  it.each(['https://t.me/ExampleChat','https://telegram.me/examplechat/456','https://t.me/s/EXAMPLECHAT/45'])('normalizes public telegram destinations: %s',url=>expect(normalizeSocialLink(url)?.key).toBe('public:examplechat'));
  it('preserves case-sensitive invitations and distinguishes public usernames',()=>{
    expect(normalizeSocialLink('https://t.me/+AbCdEfGh')?.key).toBe('invite:AbCdEfGh');
    expect(normalizeSocialLink('https://t.me/joinchat/AbCdEfGh')?.key).toBe('invite:AbCdEfGh');
    expect(normalizeSocialLink('https://t.me/+abcdefgh')?.key).not.toBe(normalizeSocialLink('https://t.me/+AbCdEfGh')?.key);
    expect(normalizeSocialLink('https://t.me/AbCdEfGh')?.key).toBe('public:abcdefgh');
  });
  it.each(['javascript:alert(1)','https://x.com.evil.com/alice','https://x.com@evil.com/alice','https://user:password@x.com/alice','https://x.com:444/alice','https://x.com','https://x.com/home','https://x.com/intent/tweet?url=hello','https://t.me/share/url?url=x','https://t.me/proxy?server=foo','https://t.me/c/123/456','https://t.co/abc','https://example.com/alice','https://x.com/alice/status/0','https://x.com/a/status/2/unknown','https://x.com\\@evil.com/alice','https://x.com/al ice'])('rejects unrelated or unsafe destination: %s',url=>expect(normalizeSocialLink(url)).toBeNull());
});
describe('independent page matching',()=>{
  it('requires distinct contracts, not pools',()=>expect(matchCards([card(1,['https://x.com/team']),card(2,['https://x.com/team'],1)])).toHaveLength(0));
  it('includes all card instances but counts each contract once',()=>{
    const groups=matchCards([card(1,['https://x.com/team']),card(2,['https://x.com/team'],1),card(3,['https://twitter.com/team'])]);
    expect(groups[0].addresses).toHaveLength(2);expect(groups[0].cardIds).toHaveLength(3);
  });
  it('does not group different posts by author',()=>expect(matchCards([card(1,['https://x.com/a/status/123']),card(2,['https://x.com/a/status/124'])])).toHaveLength(0));
  it('does not transitively merge social groups',()=>{
    const groups=matchCards([card(1,['https://x.com/a/status/123']),card(2,['https://x.com/a/status/123','https://t.me/chatters']),card(3,['https://t.me/chatters'])]);
    expect(groups).toHaveLength(2);expect(groups.every(g=>g.addresses.length===2)).toBe(true);
  });
  it('drops removed cards and honors type switches',()=>{
    const cards=[card(1,['https://x.com/team']),card(2,['https://x.com/team'])];
    expect(matchCards(cards)).toHaveLength(1);expect(matchCards(cards.slice(1))).toHaveLength(0);expect(matchCards(cards,['x_post'])).toHaveLength(0);
  });
  it('uses stable colors despite order changes',()=>expect(groupColor('x_profile:team')).toBe(matchCards([card(1,['https://x.com/team']),card(2,['https://x.com/team'])])[0].color));
});
describe('page alert state',()=>{
  const groups=(n:number)=>matchCards(Array.from({length:n},(_,i)=>card(i+1,['https://x.com/team'])));
  const opts=(now:number)=>({active:true,preferences:{...defaultExtensionPreferences,sound:true},saved:new Set<string>(),now});
  it('starts quietly and ignores sorting and redraws',()=>{
    const tracker=new PageAlerts();expect(tracker.sample(groups(2),opts(1)).alerts).toHaveLength(0);
    expect(tracker.sample(groups(2).reverse(),opts(2)).alerts).toHaveLength(0);
  });
  it('emits new groups and members with a sound cooldown',()=>{
    const tracker=new PageAlerts();tracker.sample([],opts(0));
    expect(tracker.sample(groups(2),opts(1))).toMatchObject({sound:true,alerts:[{type:'new_group'}]});
    expect(tracker.sample(groups(3),opts(2))).toMatchObject({sound:false,alerts:[{type:'new_member'}]});
    expect(tracker.sample(groups(4),opts(30002)).sound).toBe(true);
  });
  it('does not replay background changes when visible again',()=>{
    const tracker=new PageAlerts();tracker.sample([],opts(0));tracker.sample(groups(2),{...opts(1),active:false});
    expect(tracker.sample(groups(2),opts(2)).alerts).toHaveLength(0);
  });
  it('deduplicates removed/reinserted cards during cooldown',()=>{
    const tracker=new PageAlerts();tracker.sample([],opts(0));tracker.sample(groups(2),opts(1));tracker.sample([],opts(2));
    expect(tracker.sample(groups(2),opts(3)).alerts).toHaveLength(0);
  });
  it('applies watched-only filters and resets on navigation',()=>{
    const tracker=new PageAlerts();tracker.sample([],opts(0));
    expect(tracker.sample(groups(2),{...opts(1),preferences:{...defaultExtensionPreferences,watchedOnly:true}}).alerts).toHaveLength(0);
    tracker.reset();expect(tracker.sample(groups(3),opts(2)).alerts).toHaveLength(0);
  });
  it('bounds activity to fifty events',()=>{
    const tracker=new PageAlerts();tracker.sample([],opts(0));for(let i=2;i<80;i++)tracker.sample(groups(i),opts(i*31_000));expect(tracker.activity).toHaveLength(50);
  });
});
