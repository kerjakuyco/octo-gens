(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const names = {sample:"Sample tape",bybit:"Bybit",binance:"Binance",okx:"OKX"};
  const pages = {desk:"Market desk",runs:"Agent runs",portfolio:"Portfolio",links:"Connections"};
  const units = n => Number(n).toLocaleString("en-US",{maximumFractionDigits:8});
  const money = n => Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const prettyTime = s => new Date(s).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  const delta = x => x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
  const badge = (s,on=false) => `<span class="badge ${on?"on":""}">${esc(s)}</span>`;
  const options = (items,selected) => items.map(([v,t])=>`<option value="${esc(v)}"${v===selected?" selected":""}>${esc(t)}</option>`).join("");
  const compact = a => a.ticker.replace(/x$/,"").toLowerCase();
  const token = a => `<span class="token ${compact(a)}">${esc(a.ticker==="BTC"?"₿":a.ticker[0])}</span>`;
  let state=null, page="desk", range=30, busy=false, booted=false, modalType="", catalog=[], toolVenue="", preview=null;
  let toastTimer, pulseTimer, promptValue="", strategyPair="TSLAX/USDT", strategyCap="250";
  const view=$("#view"), modal=$("#modal");

  function message(text, bad=false) {
    const t=$("#toast"); t.textContent=text; t.hidden=false; t.classList.toggle("bad",bad);
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.hidden=true, bad?8500:3700);
  }
  async function progress() {
    try {
      const r=await window.pywebview.api.pulse();
      if(!busy || !r)return;
      const last=r.steps.at(-1);
      $("#workline").textContent=last?`${r.title}  /  ${last.name} · ${last.detail}`:r.title;
    } catch { /* Window may be closing. */ }
  }
  async function call(op,p={},label="Working") {
    if(busy)return null;
    busy=true; $("#workline").hidden=false; $("#workline").textContent=label+"…";
    pulseTimer=setInterval(progress,500);
    const err=modal.querySelector(".dialog-error"); if(err)err.textContent="";
    try {
      const response=await window.pywebview.api.dispatch(op,p);
      state=response.state;
      render();
      if(!response.ok)throw new Error(response.error);
      return response;
    } catch(e) {
      const text=e.message || String(e);
      if(modal.open && err)err.textContent=text; else message(text,true);
      return null;
    } finally {
      clearInterval(pulseTimer); busy=false; $("#workline").hidden=true;
    }
  }
  function dialog(type,title,description,body) {
    modalType=type;
    $("#dialog-body").innerHTML=`<div class="between"><div><div class="eyebrow">OCTO / STUDIO</div>
      <h2 id="dialog-title">${esc(title)}</h2></div><button type="button" class="sub close" aria-label="Close dialog" data-act="close">${icon("cross")}</button></div>
      <p class="desc">${esc(description)}</p>${body}<div class="dialog-error" role="alert"></div>`;
    if(!modal.open)modal.showModal();
  }
  function close(){if(modal.open)modal.close(); modalType=""; $("#dialog-body").replaceChildren();}
  modal.addEventListener("cancel",()=>{modalType="";});
  const field=(label,html)=>`<label class="field">${esc(label)}${html}</label>`;
  const submit=(text,ico="arrow")=>`<div class="dialog-actions"><button type="button" class="ghost" data-act="close">Cancel</button><button class="btn" type="submit">${esc(text)} ${icon(ico)}</button></div>`;
  function pageHead(index,title,desc,action="") {
    return `<div class="headline"><div><div class="eyebrow">${index} / TRADING STUDIO</div><h1>${title}</h1><p class="desc">${desc}</p></div>${action}</div>`;
  }
  function metric(i,title,value,unit=""){
    return `<div class="card"><div class="meta">${icon(i)} ${title}</div><div class="metric">${esc(value)} <small>${esc(unit)}</small></div></div>`;
  }
  function metrics(){
    const a=state.account,n=Object.values(state.links).filter(x=>x.connected).length;
    return `<div class="cards">${metric("layer","Paper equity",money(a.equity),"USDT")}${metric("wallet","Available paper cash",money(a.cash),"USDT")}${metric("plug","MCP connections",`${n} / 3`,"venues")}</div>`;
  }
  const ticketAction=()=>`<button class="btn" data-act="ticket">${icon("swap")} New order</button>`;
  function graph(q) {
    const vals=[...q.closes.map(Number),Number(q.price)].slice(-range);
    if(vals.length<2)return `<p class="empty">No completed daily observations yet.</p>`;
    const w=640,h=150,x0=4,x1=550,y0=12,y1=136,lo=Math.min(...vals),hi=Math.max(...vals);
    const x=i=>x0+i*(x1-x0)/(vals.length-1), y=v=>hi===lo?(y0+y1)/2:y1-(v-lo)*(y1-y0)/(hi-lo);
    const coords=vals.map((v,i)=>`${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
    const grids=[0,.5,1].map(f=>`<line class="gridline" x1="${x0}" x2="${x1}" y1="${y0+f*(y1-y0)}" y2="${y0+f*(y1-y0)}"/><text x="562" y="${y0+f*(y1-y0)+4}">${money(hi-f*(hi-lo))}</text>`).join("");
    return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(q.pair)}: ${vals.length} price observations; low ${money(lo)}, high ${money(hi)} USDT">
      <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#bdec7e" stop-opacity=".27"/><stop offset="1" stop-color="#bdec7e" stop-opacity="0"/></linearGradient></defs>
      ${grids}<polygon points="${x0},${y1} ${coords} ${x1},${y1}" fill="url(#fade)" stroke="none"/><polyline class="curve" fill="none" points="${coords}"/>
      <circle cx="${x1}" cy="${y(vals.at(-1))}" r="3.2" fill="#c2ef83" stroke="none"/><g id="crosshair" visibility="hidden"><line id="crossline" y1="3" y2="140" stroke="#93a589" stroke-dasharray="3 4"/><circle id="crosspoint" r="3" fill="white"/><text id="crosslabel" y="10"></text></g></svg></div>`;
  }
  function chartPanel(){
    const a=state.assets.find(a=>a.pair===state.focus),q=state.quotes[a.pair];
    return `<section class="panel"><div class="between"><div class="row">${token(a)}<div><div class="assettitle">${esc(a.ticker)} <small>/ USDT</small></div>
      <div class="help">${esc(a.name)} · ${esc(a.family)}</div></div></div><div class="segments" aria-label="Chart observations">
      ${[7,30,60].map(n=>`<button data-range="${n}" aria-pressed="${range===n}" class="${range===n?"sel":""}">${n}D</button>`).join("")}</div></div>
      ${q?`<div class="chart-stats"><div class="num">${money(q.price)} <small>USDT</small></div><span class="delta ${q.change>=0?"pos":"neg"}">${delta(q.change)} <span class="muted">vs prev. close</span></span></div>
      ${graph(q)}<div class="chart-foot"><span>${esc(q.source)} · ${q.sample?"fictional history":"spot, daily closes"}</span><span>${esc(q.asOf)}</span></div>`:
      `<div class="empty"><strong>Quote unavailable</strong><p>${esc(state.feedError||"Fetch the spot pair to load its price history.")}</p><button class="ghost space" data-act="refresh">Retry quote</button></div>`}</section>`;
  }
  function watchlist(){
    return `<section class="panel"><div class="between"><h2>Watchlist</h2><span class="micro">SPOT / USDT</span></div><div class="watchlist">${state.assets.map(a=>{
      const q=state.quotes[a.pair];return `<button class="watchrow ${a.pair===state.focus?"current":""}" data-pair="${esc(a.pair)}" title="Load ${esc(a.ticker)} from ${esc(names[state.source])}">${token(a)}
      <span><strong>${esc(a.ticker)}</strong><small>${esc(a.kind)}</small></span><span class="right">${q?money(q.price):"Get quote ›"}${q?`<small class="${q.change>=0?"pos":"neg"}">${delta(q.change)}</small>`:""}</span></button>`;
    }).join("")}</div></section>`;
  }
  function composer(){
    return `<section class="composer"><div class="between"><div class="row"><span class="glyph">${icon("spark")}</span><h2>Ask the desk</h2></div>
      <span class="micro">${esc(state.model||"BUILT-IN AGENTS")}</span></div>
      <form id="askform" class="composebox"><input id="prompt" aria-label="Agent prompt" maxlength="2500" autocomplete="off" placeholder="Research a token, compare assets, or draft a trade…" value="${esc(promptValue)}"><button class="btn send" aria-label="Run agent" title="Run agent">${icon("send")}</button></form>
      <div class="chips">${["Compare TSLAx and NVDAx","Review my portfolio","Buy 0.5 TSLAx"].map(p=>`<button class="chip" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}</div></section>`;
  }
  function traces(r){
    return `<div class="trace">${r.steps.map(s=>`<span class="${s.status==="error"?"err":""}" title="${esc(s.detail)}">${esc(s.name)} · ${s.ms} ms</span>`).join("")}</div>`;
  }
  function runList(list,first=false){
    if(!list.length)return `<div class="empty">No runs yet. Ask the desk about TSLAx to see the data, tool calls and result here.</div>`;
    return list.map((r,i)=>`<details class="run" ${first&&i===0?"open":""}><summary><span class="body"><strong>${esc(r.title)}</strong><span class="help">${esc(r.agent)} · ${esc(names[r.source])} · ${prettyTime(r.time)}</span></span>
      ${badge(r.status,r.status==="complete")}<span class="unit">${r.ms} ms</span></summary>${traces(r)}<pre class="out">${esc(r.output)}</pre></details>`).join("");
  }
  function desk(){return pageHead("01","Market desk","Tokenized stocks and crypto, from signal to spot order.",ticketAction())+
    metrics()+`<div class="desk-grid">${chartPanel()}${watchlist()}</div>${composer()}<div class="section-head between"><h2>Latest run</h2><button class="sub" data-page="runs">All runs ${icon("arrow")}</button></div><section class="panel">${runList(state.runs.slice(0,1),true)}</section>`;}
  const pairOptions=selected=>options(state.assets.map(a=>[a.pair,`${a.ticker} / USDT`]),selected);
  function runs(){
    return pageHead("02","Agent runs","Inspect how the desk reached a result, or put a paper strategy on watch.")+
    `<div class="section-grid"><section class="panel"><div class="between"><h2>Pattern agent</h2>${badge(state.watch?"Watching":"On demand",!!state.watch)}</div><p class="desc">Compares three daily returns with five earlier patterns. Four agreeing matches and a matching mean direction trigger a paper trade.</p>
    <form id="strategyform"><div class="formrow">${field("Instrument",`<select id="strategyPair">${pairOptions(strategyPair)}</select>`)}${field("Maximum trade · USDT",`<input id="cap" value="${esc(strategyCap)}" inputmode="decimal" required>`)}</div>
    <div class="actions"><button class="btn" type="submit">${icon("runs")} Run once</button><button type="button" class="ghost" data-act="${state.watch?"stop":"watch"}">${state.watch?"Stop watch":"Watch every 15 min"}</button></div></form></section>
    <section class="panel"><div class="micro">RUNTIME</div><h2 class="space">${esc(state.model||"Built-in agent engine")}</h2><p class="desc">Research reads the active spot feed. The portfolio agent reads its paper ledger. Every run records the tools used and elapsed time.</p>
    <div class="space">${badge(state.watch?`Watching ${state.watch.pair} · ${state.watch.budget} USDT`:"No active watch",!!state.watch)}</div></section></div>
    ${composer()}<div class="section-head between"><h2>Run journal</h2><span class="micro">LATEST ${state.runs.length}</span></div><div class="panel">${runList(state.runs,true)}</div>`;
  }
  function table(head,rows,empty){
    if(!rows.length)return `<p class="empty">${esc(empty)}</p>`;
    return `<div class="scroller"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function portfolio(){
    const a=state.account;return pageHead("03","Portfolio",`Paper ledger for ${names[state.source]}. All balances are denominated in USDT.`,ticketAction())+
    metrics()+`<div class="stack"><section class="panel"><div class="between panel-head"><h2>Open positions</h2>${badge(`${a.holdings.length} positions`)}</div>${table(["Token / pair","Units","Cost basis","Market value","Unrealized P/L"],
      a.holdings.map(h=>[h.symbol,units(h.qty),money(h.cost),money(h.value),money(Number(h.value)-Number(h.cost))]),"No open positions. Preview a paper ticket to start trading this feed.")}<p class="help">Valuations use the last fetched spot price for each holding.</p></section>
      <section class="panel"><h2>Recent paper fills</h2>${table(["Time (UTC)","Pair","Side","Units","Fill price","Status"],a.orders.map(o=>[o.submitted.slice(0,19).replace("T"," "),o.symbol,o.side,units(o.filled),money(o.price),o.status]),"Filled paper tickets will appear here.")}</section></div>`;
  }
  function links(){
    return pageHead("04","Connections","Connect an exchange MCP server, inspect its tools, and choose your market-data source.")+
    `<div class="venues">${["bybit","binance","okx"].map(v=>{
      const l=state.links[v];return `<section class="panel venue"><div class="between"><span class="venue-logo ${v}">${({bybit:"BY",binance:"BN",okx:"OK"})[v]}</span>${badge(l.connected?"Connected":"Offline",l.connected)}</div><h2>${names[v]}</h2>
      <p class="desc">${l.connected?`${esc(l.name)} · ${esc(l.version)}<br>${l.count} discovered tools · ${esc(l.transport)}`:v==="binance"?"Built-in spot MCP · Binance has no official server":"Official MCP plus verified spot tools"}</p><div class="actions">
      ${l.connected?`<button class="ghost" data-tools="${v}">Inspect tools</button>${l.feed&&v!==state.source?`<button class="sub" data-feed="${v}">Use feed</button>`:""}<button class="sub" data-unlink="${v}">Disconnect</button>`:`<button class="ghost" data-link="${v}">${icon("plug")} Connect</button>`}</div></section>`;}).join("")}</div>
      <section class="panel space"><span class="micro">INSTRUMENT IDENTITY</span><h2 class="space">A token is its own market.</h2><p class="desc">TSLAx, AAPLx, NVDAx and SPYx are xStocks. The bundled servers check the exact token, USDT quote, spot category and listing status before pricing or submitting a ticket. A missing listing is reported for that venue.</p></section>`;
  }
  function render(){
    if(!state)return;
    $("#crumb").textContent=pages[page]; $("#link-count").textContent=Object.values(state.links).filter(l=>l.connected).length;
    document.querySelectorAll(".nav[data-page]").forEach(n=>{n.classList.toggle("active",n.dataset.page===page);n.setAttribute("aria-current",n.dataset.page===page?"page":"false");});
    $("#source").innerHTML=options([["sample","Sample tape"],...Object.keys(state.links).filter(v=>state.links[v].feed&&state.links[v].connected).map(v=>[v,names[v]+" spot MCP"]),["add","＋ Connections…"]],state.source);
    $(".source .dot").classList.toggle("green",state.source!=="sample");
    view.innerHTML=({desk,runs,portfolio,links})[page]();
  }
  function navigate(name){page=name;render();window.scrollTo(0,0);}
  async function ask(prompt){
    if(!prompt.trim()||busy)return;
    promptValue="";
    const r=await call("ask",{prompt},"Starting agent run");
    if(r?.result?.ticket)showPreview(r.result.ticket);
    else if(r){navigate("runs"); const log=view.querySelector(".run"); if(log)log.scrollIntoView({block:"nearest"});}
  }
  function showTicket(){
    dialog("ticket","New spot order",`Market order · ${names[state.source]} · quantity in base tokens.`,
      `<form id="ticketform">${field("Instrument",`<select name="pair">${pairOptions(state.focus)}</select>`)}<div class="formrow">${field("Side",`<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select>`)}
      ${field("Quantity",`<input name="qty" required inputmode="decimal" placeholder="0.5">`)}</div>
      ${field("Execution destination",`<select name="destination"><option value="paper">Paper account · USDT</option>${state.links[state.source]?.trading?`<option value="exchange">Live · ${names[state.source]} spot</option>`:""}</select>`)}${submit("Preview order")}</form>`);
  }
  function showPreview(t){
    preview=t;
    dialog("preview",t.destination==="paper"?"Paper ticket":"Live spot ticket","Review the exact instrument, quantity and destination.",
      `<form id="previewform"><div class="preview">${[["Instrument",t.pair],["Side / units",`${t.side.toUpperCase()} ${units(t.qty)}`],["Venue / feed",names[t.source]],["Reference price",`${money(t.price)} USDT`],["Estimated value",`${money(t.value)} USDT`],["Destination",t.destination==="paper"?"Simulated paper account":"Real exchange account"]].map(([k,v])=>`<span>${esc(k)}</span><strong>${esc(v)}</strong>`).join("")}</div>${submit(t.destination==="paper"?"Place paper order":"Send live market order","swap")}</form>`);
  }
  function showConnect(v){
    const official=v!=="binance"&&state.runtime.node;
    dialog("connect",`Connect ${names[v]}`,"The client starts a local MCP process, negotiates the session, and reads its tool schemas.",
      `<form id="connectform" data-venue="${v}" autocomplete="off">${field("MCP server",`<select name="transport" id="transport">${official?`<option value="official">Official ${names[v]} MCP · ${esc(state.packages[v])}</option>`:""}<option value="bundled">Built-in ${names[v]} spot server</option><option value="stdio">Custom MCP command</option><option value="http">Remote MCP · Streamable HTTP</option></select>`)}
      <div id="transportfields"></div>${submit("Connect server","plug")}</form>`);
    transportFields(v,official?"official":"bundled");
  }
  function credentials(v){
    return `<details class="space"><summary>Account credentials (optional, this session only)</summary>${field("API key",'<input name="key" autocomplete="off">')}${field("API secret",'<input name="secret" type="password" autocomplete="off">')}${v==="okx"?field("API passphrase",'<input name="passphrase" type="password" autocomplete="off">'):""}</details>`;
  }
  function transportFields(v,mode){
    const f=$("#transportfields");
    if(mode==="official"&&v==="bybit")f.innerHTML=`<p class="help">Starts Bybit’s official server with npx, plus the built-in spot adapter for verified token/USDT tickets. Credentials stay in that process and are not saved.</p>${credentials(v)}<label class="field"><span><input name="testnet" type="checkbox"> Use Bybit testnet</span></label>`;
    else if(mode==="official")f.innerHTML=`<p class="help">Starts OKX’s official server. Market tools need no key. Live and demo profiles use the OKX config file already on this computer; this app does not write it.</p>${field("Official profile",'<select name="profile"><option value="market">Market tools only</option><option value="demo">Existing demo profile</option><option value="live">Existing live profile</option></select>')}`;
    else if(mode==="bundled")f.innerHTML=`<p class="help">${v==="binance"?"Binance publishes agent skills, not an MCP server. This built-in server speaks MCP and checks Binance spot listings.":"Public market tools work without keys."} Credentials enable balances and live spot tickets for this session only.</p>${credentials(v)}`;
    else if(mode==="http")f.innerHTML=field("MCP endpoint",`<input name="url" type="url" placeholder="https://your-server.example/mcp" required>`)+field("Bearer token (optional)",`<input name="token" type="password" autocomplete="off">`);
    else f.innerHTML=field("Executable",`<input name="command" placeholder="node.exe, or a full path" required>`)+field("Argument list · JSON",`<textarea name="args" rows="2" placeholder='["/path/to/server.js"]'>[]</textarea>`)+field("Environment · JSON (session only)",`<textarea name="env" spellcheck="false" rows="2" placeholder='{"VARIABLE":"value"}'>{}</textarea>`);
  }
  async function inspect(v){
    const r=await call("catalog",{venue:v},"Reading tool catalog"); if(!r)return;
    catalog=r.result.tools;toolVenue=v;
    dialog("tools",`${names[v]} tool inspector`,`${catalog.length} tools advertised in the active MCP session.`,
      `<form id="toolform">${field("Discovered tool",`<select id="toolname">${options(catalog.map(t=>[t.name,t.name]),catalog[0]?.name)}</select>`)}
      <p class="help" id="toolhelp"></p><details class="space"><summary>Input schema</summary><pre class="out tool-schema" id="schema"></pre></details>
      ${field("Arguments · JSON",'<textarea id="toolargs" spellcheck="false" rows="4">{}</textarea>')}<div class="actions"><button class="btn" type="submit">Run tool ${icon("arrow")}</button><button class="ghost" type="button" data-act="to-prompt">Use in prompt</button></div>
      <pre class="out" id="toolout" hidden></pre></form>`);
    toolFields();
  }
  function toolFields(){
    const t=catalog.find(x=>x.name===$("#toolname").value);
    if(!t)return;
    $("#toolhelp").textContent=t.description;$("#schema").textContent=JSON.stringify(t.schema,null,2);
    const args={};for(const k of t.schema.required||[])args[k]=({pair:state.focus,category:"spot",symbol:state.focus.replace("/","")})[k]??"";
    $("#toolargs").value=JSON.stringify(args,null,2);$("#toolout").hidden=true;
  }
  function settings(){
    dialog("model","Local model","Built-in agents run on-device. Add an installed Ollama model for natural-language research explanations.",
      `<form id="modelform">${field("Ollama model tag",`<input name="model" value="${esc(state.model)}" placeholder="qwen3:4b">`)}<p class="help">Local endpoint: 127.0.0.1:11434. Leave blank to use the built-in engine.</p>${submit("Save settings")}</form>`);
  }
  function focus(){if(!["desk","runs"].includes(page))navigate("desk");$("#prompt")?.focus();}
  document.addEventListener("click",async e=>{
    const el=e.target.closest("button");if(!el||!state)return;
    if(el.dataset.page){navigate(el.dataset.page);return;}
    const a=el.dataset.act;if(a==="close"){close();return;}if(a==="focus"){focus();return;}
    if(busy)return;
    if(el.dataset.range){range=Number(el.dataset.range);render();return;}
    if(el.dataset.pair){await call("select",{pair:el.dataset.pair},"Fetching verified price");return;}
    if(el.dataset.prompt){await ask(el.dataset.prompt);return;}
    if(el.dataset.link){showConnect(el.dataset.link);return;}
    if(el.dataset.unlink){await call("disconnect",{venue:el.dataset.unlink},"Closing MCP session");return;}
    if(el.dataset.feed){await call("source",{source:el.dataset.feed},"Switching venue");return;}
    if(el.dataset.tools){await inspect(el.dataset.tools);return;}
    if(a==="settings")settings();
    if(a==="ticket")showTicket();
    if(a==="refresh")await call("select",{pair:state.focus},"Refreshing quote");
    if(a==="stop")await call("stop",{},"Stopping watch");
    if(a==="watch")await call("watch",{pair:strategyPair,budget:strategyCap},"Starting paper watch");
    if(a==="to-prompt"){promptValue=`@${toolVenue} ${$("#toolname").value} ${$("#toolargs").value.replace(/\n/g," ")}`;close();navigate("runs");focus();}
  });
  document.addEventListener("change",async e=>{
    if(e.target.id==="source"){
      if(busy){render();return;} const v=e.target.value;if(v==="add")navigate("links");else await call("source",{source:v},"Switching venue");
    }
    if(e.target.id==="transport")transportFields($("#connectform").dataset.venue,e.target.value);
    if(e.target.id==="toolname")toolFields();
    if(e.target.id==="strategyPair")strategyPair=e.target.value;
  });
  document.addEventListener("input",e=>{if(e.target.id==="prompt")promptValue=e.target.value;if(e.target.id==="cap")strategyCap=e.target.value;});
  document.addEventListener("submit",async e=>{
    e.preventDefault();if(busy)return;
    const f=e.target,p=Object.fromEntries(new FormData(f));
    try {
      if(f.id==="askform"){await ask($("#prompt").value);return;}
      if(f.id==="strategyform"){await call("pattern",{pair:strategyPair,budget:strategyCap},"Evaluating pattern");return;}
      if(f.id==="ticketform"){const r=await call("prepare",p,"Pricing ticket");if(r)showPreview(r.result.ticket);return;}
      if(f.id==="previewform"){const r=await call("submit",{id:preview.id},"Submitting ticket");if(r){close();navigate(preview.destination==="paper"?"portfolio":"runs");message(r.state.runs[0].output);}return;}
      if(f.id==="connectform"){
        if(p.transport==="stdio"){p.args=JSON.parse(p.args);p.env=JSON.parse(p.env);}
        if(await call("connect",{venue:f.dataset.venue,config:p},"Negotiating MCP session")){close();message("MCP session connected.");}return;
      }
      if(f.id==="toolform"){const r=await call("tool",{venue:toolVenue,name:$("#toolname").value,args:JSON.parse($("#toolargs").value)},"Calling MCP tool");
        if(r&&$("#toolout")){$("#toolout").hidden=false;$("#toolout").textContent=r.result.toolOutput;}return;}
      if(f.id==="modelform"){if(await call("model",p,"Saving model preference"))close();}
    } catch(err){const box=modal.querySelector(".dialog-error");if(box)box.textContent=err.message;else message(err.message,true);}
  });
  document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"&&!modal.open){e.preventDefault();focus();}});
  view.addEventListener("pointermove",e=>{
    const chart=e.target.closest(".chart");if(!chart)return;
    const v=[...state.quotes[state.focus].closes.map(Number),Number(state.quotes[state.focus].price)].slice(-range);
    const rect=chart.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*640-4)/546));
    const i=Math.round(ratio*(v.length-1)),x=4+i*546/(v.length-1),lo=Math.min(...v),hi=Math.max(...v);
    $("#crosshair").setAttribute("visibility","visible");$("#crossline").setAttribute("x1",x);$("#crossline").setAttribute("x2",x);
    $("#crosspoint").setAttribute("cx",x);$("#crosspoint").setAttribute("cy",hi===lo?74:136-(v[i]-lo)*124/(hi-lo));
    $("#crosslabel").setAttribute("x",Math.min(x+6,450));$("#crosslabel").textContent=money(v[i])+" USDT";
  });
  view.addEventListener("pointerout",e=>{if(e.target.closest(".chart")&&!e.relatedTarget?.closest?.(".chart"))$("#crosshair")?.setAttribute("visibility","hidden");});
  async function boot(){
    if(booted||!window.pywebview?.api)return;booted=true;
    $("#hotkey").textContent=/Mac/.test(navigator.platform)?"⌘ K":"Ctrl K";
    const ok=await call("boot",{},"Opening local workspace");
    if(ok)document.documentElement.dataset.ready="true";
  }
  window.addEventListener("pywebviewready",boot);boot();
  setInterval(async()=>{if(!busy&&state?.watch&&!modal.open&&!$("#prompt")?.matches(":focus"))await call("state",{},"Updating watch");},60000);
})();
