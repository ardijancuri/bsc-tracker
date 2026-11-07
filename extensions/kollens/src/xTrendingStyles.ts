export const xTrendingStyles = `
:host { display:block; min-width:0; width:100%; margin:0 0 12px; }
* { box-sizing:border-box; }
.panel {
  --gutter:16px; --text:var(--x-text,#f1f4f5); --line:var(--x-border,#262d30);
  --muted:color-mix(in srgb,var(--text) 68%,transparent); --gold:#f0b90b;
  overflow:hidden; border:1px solid var(--line); border-radius:16px; background:transparent; color:var(--text);
  font:13px/1.4 system-ui,sans-serif; text-align:start;
}
.header { display:flex; justify-content:space-between; align-items:center; gap:6px; padding:12px var(--gutter) 14px; }
h2 { margin:0; font-size:var(--x-title-size,20px); font-weight:750; letter-spacing:-.02em; }
.brand { display:inline-flex; align-items:center; gap:4px; color:var(--text); text-decoration:none; font-weight:750; font-size:11px; }
.brand-icon { display:block; width:15px; height:15px; }
.tools { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0 var(--gutter) 9px; }
.filters { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); flex:0 1 240px; min-width:0; gap:1px; padding:2px;
  border-radius:999px; background:color-mix(in srgb,var(--text) 9%,transparent); }
button { border:0; background:transparent; color:var(--muted); font:inherit; cursor:pointer; }
.filters button { padding:3px 0; border-radius:999px; font-size:11px; white-space:nowrap; }
.filters button:hover { color:var(--text); }
.filters [aria-pressed=true] { background:rgb(128 128 128 / 34%); color:var(--text); font-weight:750; }
.chain { display:block; width:15px; height:15px; flex:none; }
.list { list-style:none; padding:0; margin:0; max-height:348px; overflow:auto; scrollbar-width:thin; scrollbar-color:#414b4f transparent; }
.list li + li > .token::before { content:''; position:absolute; inset:0 var(--gutter) auto; height:1px; pointer-events:none;
  background:color-mix(in srgb,var(--text) 11%,transparent); transition:opacity .15s; }
.list:not(.skeleton-list) > li:hover > .token::before,
.list:not(.skeleton-list) > li:hover + li > .token::before { opacity:0; }
.token { --avatar-size:42px; position:relative; display:grid; grid-template-columns:var(--avatar-size) minmax(0,1fr) auto; align-items:center; gap:5px 10px;
  padding:8px var(--gutter); color:inherit; text-decoration:none; transition:background-color .15s; }
a.token:hover { background:color-mix(in srgb,var(--text) 7%,transparent); }
.avatar { width:var(--avatar-size); height:var(--avatar-size); display:grid; place-items:center; overflow:hidden; border-radius:8px;
  background:#272c2c; color:#f8d463; font-weight:750; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.identity { display:grid; gap:2px; min-width:0; }
.identity strong, .kols { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.identity strong { font-size:13px; }
.kols,.metrics { color:var(--muted); font-size:11px; }
.activity { text-align:end; white-space:nowrap; }
.activity strong { color:var(--gold); font-weight:750; font-size:12px; }
.counts { display:grid; justify-items:end; gap:1px; margin-top:4px; font-size:10px; line-height:1.15; font-variant-numeric:tabular-nums; }
.buy { color:#62d4a1; } .sell { color:#ffa39a; }
.metrics { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:2px 12px; }
.metric { white-space:nowrap; }
.metrics strong { color:var(--text); font-weight:650; }
.skeleton-list { overflow:hidden; }
.skeleton-row .identity { grid-template-rows:18px 15px; align-items:center; }
.skeleton-row .activity { display:grid; grid-template-rows:18px 12px 12px; gap:2px; justify-items:end; align-items:center; }
.skeleton-row .metrics { min-height:1.4em; align-items:center; }
.skeleton-bar { display:block; width:46px; height:7px; border-radius:999px; }
.skeleton-row .identity .skeleton-bar { width:min(96px,75%); height:9px; }
.skeleton-row .identity .skeleton-bar + .skeleton-bar { width:min(132px,90%); height:7px; }
.skeleton-row .activity .skeleton-bar + .skeleton-bar { width:36px; }
.skeleton-row .avatar,.skeleton-bar { background:color-mix(in srgb,var(--text) 15%,transparent); animation:token-loading 1.4s ease-in-out infinite alternate; }
@keyframes token-loading { from { opacity:.58; } to { opacity:1; } }
.loading-label { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.status { margin:0; padding:15px var(--gutter); color:var(--muted); border-top:1px solid var(--line); }
.retry { color:#f8d463; padding:2px 0; }
:focus-visible { outline:2px solid var(--gold); outline-offset:-2px; }
@media (prefers-reduced-motion:reduce) {
  .token,.token::before { transition:none; }
  .skeleton-row .avatar,.skeleton-bar { animation:none; }
}
`;
