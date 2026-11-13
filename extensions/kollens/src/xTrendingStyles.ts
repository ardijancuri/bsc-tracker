export const xTrendingStyles = `
:host { display:block; min-width:0; width:100%; margin:0 0 12px; container-type:inline-size; }
* { box-sizing:border-box; }
.panel {
  --gutter:16px; --text:var(--x-text,#f1f4f5); --line:var(--x-border,#262d30);
  --muted:color-mix(in srgb,var(--text) 68%,transparent); --gold:#f0b90b;
  --buy-text:color-mix(in srgb,var(--text) 64%,#34976d);
  --buy-border:color-mix(in srgb,var(--buy-text) 62%,var(--line));
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
.filters [aria-disabled=true] { opacity:.65; cursor:wait; }
.chain { display:block; width:15px; height:15px; flex:none; }
.feed,.skeleton-list { max-height:min(520px,65vh); overflow:auto; scrollbar-width:none; }
.list { list-style:none; padding:0; margin:0; }
.market-header,.tracked-heading { margin:0; padding:7px var(--gutter) 3px; }
.market-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.market-header h3,.tracked-heading { margin:0; font-size:12px; font-weight:700; }
.market-source { color:var(--muted); font-size:10px; }
.tracked-heading { padding-top:12px; border-top:1px solid var(--line); }
.market-change { color:#62d4a1; font-weight:700; font-variant-numeric:tabular-nums; }
.market-row .counts { flex-wrap:wrap; }
.token-row,.skeleton-row { --avatar-size:42px; position:relative; display:grid;
  grid-template-columns:var(--avatar-size) minmax(0,1fr) auto; grid-template-rows:21px 21px auto auto;
  column-gap:10px; padding:8px var(--gutter); }
.token-row { transition:background-color .15s; }
.list > li + li > :is(.token-row,.token)::before { content:''; position:absolute; inset:0 var(--gutter) auto; height:1px; pointer-events:none;
  background:color-mix(in srgb,var(--text) 11%,transparent); transition:opacity .15s; }
.list > li:is(:hover,:focus-within) > .token-row::before,
.list > li:is(:hover,:focus-within) + li > .token-row::before { opacity:0; }
.token-row > .token { grid-area:1 / 1 / 5 / 4; display:grid; grid-template-columns:subgrid; grid-template-rows:subgrid;
  margin:-8px calc(-1 * var(--gutter)); padding:8px var(--gutter); color:inherit; text-decoration:none; }
.tracked-row { grid-template-columns:var(--avatar-size) minmax(0,1fr) 80px; }
.tracked-row > .token { grid-area:1 / 1 / 3 / 3; min-width:0; }
.tracked-row > .activity { grid-area:4 / 1 / 5 / 3; justify-self:start; display:flex; flex-wrap:wrap;
  align-items:center; gap:2px 8px; padding-inline-end:54px; white-space:normal; }
.tracked-row .activity strong,.tracked-row .counts > :is(.buy,.sell) { white-space:nowrap; }
.tracked-row .counts { flex-wrap:wrap; justify-content:start; }
.tracked-row > .market-details { grid-area:3 / 1 / 4 / 3; }
.tracked-row > .kol-toggle { grid-area:4 / 1 / 5 / 3; justify-self:end; }
.list > li:is(:hover,:focus-within) > :is(.token-row,.kol-dropdown) { background:color-mix(in srgb,var(--text) 7%,transparent); }
.avatar { grid-area:1 / 1 / 3; width:var(--avatar-size); height:var(--avatar-size); display:grid; place-items:center; overflow:hidden; border-radius:8px;
  background:#272c2c; color:#f8d463; font-weight:750; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.artwork-preview { position:fixed; inset:auto; margin:0; padding:0; overflow:hidden; pointer-events:none;
  border:1px solid var(--line); border-radius:12px; background:color-mix(in srgb,var(--line) 95%,var(--text));
  box-shadow:0 8px 28px rgb(0 0 0 / 30%); }
.artwork-preview img { display:block; width:100%; height:100%; object-fit:contain; }
.identity { grid-area:1 / 2; align-self:end; min-width:0; }
.identity strong { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:13px; }
.token-address { grid-area:2 / 2; z-index:1; align-self:start; justify-self:start; max-width:100%; padding:0; border-radius:3px;
  display:inline-flex; align-items:center; gap:4px; font-size:11px; }
.token-address span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.token-address svg { width:12px; height:12px; flex:none; }
.token-address:hover,.token-address:focus-visible { color:var(--text); }
.activity { grid-area:1 / 3 / 3; align-self:center; text-align:end; white-space:nowrap; }
.activity strong { color:var(--text); font-weight:750; font-size:13px; }
.counts { display:flex; align-items:center; justify-content:end; gap:4px; margin-top:2px;
  font-size:10px; line-height:1.15; font-variant-numeric:tabular-nums; }
.counts-dot { width:2px; height:2px; flex:none; border-radius:50%; background:var(--muted); }
.buy { color:#62d4a1; } .sell { color:#ffa39a; }
.metrics { grid-area:4 / 1 / 5 / 4; display:flex; flex-wrap:wrap; align-items:center; gap:2px 12px;
  min-height:20px; margin-top:5px; color:var(--muted); font-size:11px; }
.metric { white-space:nowrap; }
.metrics strong,.market-details strong { color:var(--text); font-weight:650; }
.market-details { grid-area:3 / 1 / 4 / 4; display:flex; justify-content:space-between; align-items:center;
  min-width:0; gap:8px; margin-top:8px; color:var(--muted); font-size:11px; font-variant-numeric:tabular-nums; }
.token-buy { grid-area:1 / 3 / 4; display:grid; align-content:space-between; justify-items:end; gap:3px;
  min-width:0; padding:6px; border:1px solid var(--buy-border); border-radius:7px;
  color:var(--buy-text); font-size:11px; font-weight:650; line-height:1.15; }
button.token-buy:not([aria-disabled=true]):hover { background:color-mix(in srgb,var(--buy-text) 10%,transparent); }
button.token-buy:focus-visible { outline-color:var(--buy-text); }
.token-buy[aria-disabled=true] { opacity:.65; cursor:wait; }
.token-buy[aria-busy=true] { opacity:1; background:color-mix(in srgb,var(--buy-text) 12%,transparent); }
.buy-label { display:flex; align-items:center; gap:3px; }
.buy-label svg { width:12px; height:12px; fill:currentColor; stroke:currentColor; stroke-linejoin:round; }
.token-buy { grid-area:1 / 3 / 5 / 4; }
.token-buy .metrics { display:grid; grid-area:auto; gap:2px; width:100%; min-height:0; margin:0; font-size:10px; }
.token-buy .metric { display:flex; justify-content:flex-end; gap:2px; min-width:0; }
.token-buy .metric strong { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.token-pair { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.token-tax { display:inline-flex; align-items:center; flex:none; gap:3px; padding:2px 5px; border-radius:4px;
  background:color-mix(in srgb,var(--text) 9%,transparent); color:var(--muted); font-size:10px; font-weight:650; line-height:1.2;
  white-space:nowrap; }
.token-tax[data-known=true] { color:color-mix(in srgb,#8d81ef 75%,var(--text)); background:rgb(141 129 239 / 16%); }
.token-tax svg { width:11px; height:11px; flex:none; fill:none; stroke:currentColor; stroke-width:1.35;
  stroke-linecap:round; stroke-linejoin:round; }
.kol-toggle { grid-area:4 / 3; z-index:1; align-self:end; justify-self:end; display:inline-flex; align-items:center;
  min-height:20px; gap:2px; padding:1px 6px; border:1px solid color-mix(in srgb,var(--text) 23%,transparent);
  border-radius:999px; font-size:10px; white-space:nowrap; }
.kol-toggle:hover,.kol-toggle[aria-expanded=true] { color:var(--text); border-color:color-mix(in srgb,var(--text) 38%,transparent); }
.kol-toggle svg { width:10px; height:10px; flex:none; transition:transform .15s; }
.kol-toggle[aria-expanded=true] svg { transform:rotate(180deg); }
.kol-dropdown { padding:10px var(--gutter); font-size:11px; }
.kol-dropdown[hidden] { display:none; }
.kol-dropdown-label { margin:0 0 5px; color:var(--muted); }
.kol-names { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 8px; list-style:none;
  margin:0; padding:0; max-height:125px; overflow:auto; scrollbar-width:none; }
.kol-pill { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:3px 8px; border-radius:999px;
  background:color-mix(in srgb,var(--text) 9%,transparent); color:var(--text); text-decoration:none; }
.kol-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kol-pill svg { width:9px; height:9px; flex:none; color:var(--muted); }
a.kol-pill:hover { background:color-mix(in srgb,var(--text) 16%,transparent); }
a.kol-pill:hover svg { color:var(--text); }
.skeleton-list { overflow:hidden; }
.skeleton-row .identity { grid-row:1 / 3; align-self:center; display:grid; grid-template-rows:18px 15px; align-items:center; }
.skeleton-row .activity { display:grid; grid-template-rows:18px 12px; gap:2px; justify-items:end; align-items:center; }
.skeleton-row .market-details { min-height:1.4em; align-items:center; }
.skeleton-bar { display:block; width:46px; height:7px; border-radius:999px; }
.skeleton-row .identity .skeleton-bar { width:min(96px,75%); height:9px; }
.skeleton-row .identity .skeleton-bar + .skeleton-bar { width:min(132px,90%); height:7px; }
.skeleton-row .activity .skeleton-bar + .skeleton-bar { width:36px; }
.skeleton-row .token-buy { align-content:center; border-color:var(--line); }
.skeleton-row .avatar,.skeleton-bar { background:color-mix(in srgb,var(--text) 15%,transparent); animation:token-loading 1.4s ease-in-out infinite alternate; }
@keyframes token-loading { from { opacity:.58; } to { opacity:1; } }
.loading-label { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.status { margin:0; padding:15px var(--gutter); color:var(--muted); border-top:1px solid var(--line); }
.buy-status-anchor { position:relative; height:0; z-index:2; pointer-events:none; }
.buy-status { --status-color:var(--muted); position:absolute; inset:4px var(--gutter) auto; display:flex; align-items:flex-start; pointer-events:auto;
  gap:8px; padding:9px 10px; border:1px solid color-mix(in srgb,var(--status-color) 45%,var(--line)); border-radius:10px;
  background:color-mix(in srgb,var(--line) 92%,var(--text)); box-shadow:0 4px 16px rgb(0 0 0 / 25%);
  color:var(--text); font-size:11px; line-height:16px; overflow-wrap:anywhere; }
.buy-status[hidden] { display:none; }
.buy-status[data-state=error] { --status-color:#ea6e71; }
.buy-status svg { width:16px; height:16px; flex:none; fill:none; stroke:var(--status-color);
  stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; }
.retry { color:#f8d463; padding:2px 0; }
:focus-visible { outline:2px solid var(--gold); outline-offset:-2px; }
@container (max-width: 280px) {
  .panel { --gutter:11px; }
  h2 { font-size:clamp(16px,7cqi,18px); }
  .tracked-row { grid-template-columns:var(--avatar-size) minmax(0,1fr) 73px; column-gap:7px; }
  .tracked-row > .activity { padding-inline-end:0; }
  .tracked-row > .kol-toggle { grid-area:5 / 1 / 6 / 3; }
  .tracked-row .counts { gap:2px 3px; }
  .tracked-row .market-details { gap:4px; }
  .tracked-row .token-tax { padding-inline:3px; }
  .tracked-row .token-buy { grid-row-end:6; padding-inline:4px; }
}
@media (prefers-reduced-motion:reduce) {
  .token-row,.token-row::before,.kol-toggle svg { transition:none; }
  .skeleton-row .avatar,.skeleton-bar { animation:none; }
}
`;
