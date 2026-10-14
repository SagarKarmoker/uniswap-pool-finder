const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;
let currentPage = 1;

let previousPoolIds = new Set();
let hadPrevious = false;

function shortAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chainMeta(chain) {
  if (chain === "robinhood") {
    return { name: "Robinhood", slug: "robinhood", explorer: "https://robinhoodchain.blockscout.com" };
  }
  return { name: "Base", slug: "base", explorer: "https://basescan.org" };
}

function computePrice(sqrtPriceX96, dec0, dec1) {
  if (sqrtPriceX96 == null) return "—";
  try {
    const v = BigInt(sqrtPriceX96);
    const sqrt = Number(v) / 2 ** 96;
    const raw = sqrt * sqrt;
    const adj = raw * Math.pow(10, dec0 - dec1);
    if (!isFinite(adj)) return "—";
    if (adj < 0.0001) return adj.toExponential(4);
    if (adj > 1e9) return adj.toExponential(4);
    return adj.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  } catch {
    return "—";
  }
}

let poolsCache = [];
let hasShownBaseline = false;

async function fetchPools() {
  const res = await fetch("/api/pools");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

function render(pools) {
  const chainSel = ($("chainSelect") && $("chainSelect").value) || "all";
  const protoSel = ($("protocolSelect") && $("protocolSelect").value) || "both";
  let visible = pools;
  if (chainSel !== "all") visible = visible.filter((p) => (p.chain || "base") === chainSel);
  if (protoSel !== "both") visible = visible.filter((p) => p.protocol.toLowerCase() === (protoSel === "v3" ? "v3" : "v4"));

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageItems = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const newIds = new Set(visible.filter((p) => hadPrevious && !previousPoolIds.has(p.pool)).map((p) => p.pool));

  const resultsEl = $("results");
  const frag = document.createDocumentFragment();
  for (const p of pageItems) {
    const m0 = p.token0Meta || { symbol: shortAddr(p.token0), name: shortAddr(p.token0), decimals: 18 };
    const m1 = p.token1Meta || { symbol: shortAddr(p.token1), name: shortAddr(p.token1), decimals: 18 };
    if (p.token0 === "0x0000000000000000000000000000000000000000") { m0.symbol = "ETH"; m0.name = "Native Ether"; m0.decimals = 18; }
    if (p.token1 === "0x0000000000000000000000000000000000000000") { m1.symbol = "ETH"; m1.name = "Native Ether"; m1.decimals = 18; }

    const st = { sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, liquidity: p.liquidity, bal0: p.bal0, bal1: p.bal1 };
    const isDynamic = Number(p.fee) >= 0x800000;
    const feePct = isDynamic ? "dynamic" : (Number(p.fee) / 10000).toFixed(2) + "%";
    const price = computePrice(p.sqrtPriceX96, m0.decimals, m1.decimals);
    const bal0Fmt = p.bal0 != null ? formatUnits(p.bal0, m0.decimals) : "—";
    const bal1Fmt = p.bal1 != null ? formatUnits(p.bal1, m1.decimals) : "—";
    const isNew = hadPrevious && newIds.has(p.pool);
    const ch = chainMeta(p.chain);

    const card = document.createElement("div");
    card.className = "card p-4 space-y-3";
    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="display text-xl font-bold">${escapeHtml(m0.symbol || "?")} <span class="text-slate-500">/</span> ${escapeHtml(m1.symbol || "?")}</div>
          <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(m0.name || "")} · ${escapeHtml(m1.name || "")}</div>
        </div>
        <div class="flex gap-2 flex-wrap justify-end">
          <span class="text-xs px-2 py-1 rounded-full bg-slate-500/15 text-slate-200 border border-slate-500/30">${ch.name}</span>
          <span class="text-xs px-2 py-1 rounded-full bg-violet-500/10 text-violet-300 border border-violet-500/20">${p.protocol}</span>
          ${isNew ? '<span class="text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">NEW</span>' : ""}
          <span class="text-xs px-2 py-1 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">${feePct} fee</span>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">Pool</span><div class="font-mono text-[11px] mt-0.5 break-all">${p.protocol === "V3" ? `<a href="${ch.explorer}/address/${p.pool}" target="_blank" rel="noopener" class="hover:text-cyan-300 underline decoration-dotted">${p.pool}</a>` : p.pool}</div></div>
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">Created</span><div class="mt-0.5">block ${Number(p.blockNumber).toLocaleString()}</div></div>
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">Price (${escapeHtml(m1.symbol)}/${escapeHtml(m0.symbol)})</span><div class="mt-0.5 font-semibold">${price}</div></div>
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">In-range liquidity</span><div class="mt-0.5 font-mono text-[11px]">${p.liquidity != null ? p.liquidity : "—"}</div></div>
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">Reserve ${escapeHtml(m0.symbol)}</span><div class="mt-0.5">${bal0Fmt}</div></div>
        <div class="bg-white/5 rounded-lg p-2"><span class="text-slate-400">Reserve ${escapeHtml(m1.symbol)}</span><div class="mt-0.5">${bal1Fmt}</div></div>
      </div>
      <details class="text-xs">
        <summary class="cursor-pointer text-slate-400 hover:text-slate-200">Token & pool details</summary>
        <div class="mt-2 space-y-2 font-mono text-[11px] break-all">
          <div><span class="text-slate-500">token0:</span> ${p.token0 === "0x0000000000000000000000000000000000000000" ? p.token0 : `<a href="${ch.explorer}/token/${p.token0}" target="_blank" rel="noopener" class="hover:text-cyan-300 underline decoration-dotted">${p.token0}</a>`} · ${escapeHtml(m0.name)} · ${m0.symbol} · ${m0.decimals} dec</div>
          <div><span class="text-slate-500">token1:</span> ${p.token1 === "0x0000000000000000000000000000000000000000" ? p.token1 : `<a href="${ch.explorer}/token/${p.token1}" target="_blank" rel="noopener" class="hover:text-cyan-300 underline decoration-dotted">${p.token1}</a>`} · ${escapeHtml(m1.name)} · ${m1.symbol} · ${m1.decimals} dec</div>
          <div><span class="text-slate-500">tick:</span> ${p.tick != null ? p.tick : "—"} · <span class="text-slate-500">tickSpacing:</span> ${p.tickSpacing}</div>
          <div><span class="text-slate-500">hooks:</span> ${p.hooks || "—"}</div>
          <div><span class="text-slate-500">tx:</span> ${p.txHash}</div>
        </div>
      </details>
      <div class="flex gap-2 text-xs flex-wrap">
        <a href="${ch.explorer}/tx/${p.txHash}" target="_blank" rel="noopener" class="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 transition">Creation tx</a>
        <a href="https://app.uniswap.org/explore/pools/${ch.slug}/${p.pool}" target="_blank" rel="noopener" class="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 transition">Uniswap</a>
      </div>
    `;
    frag.appendChild(card);
  }
  resultsEl.innerHTML = "";
  resultsEl.appendChild(frag);

  const pag = $("pagination");
  if (pag) {
    pag.innerHTML = `
      <button id="prevPage" class="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 disabled:opacity-40" ${currentPage <= 1 ? "disabled" : ""}>Prev</button>
      <span>Page ${currentPage} / ${totalPages} · ${visible.length} pools</span>
      <button id="nextPage" class="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 disabled:opacity-40" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
    `;
    const prev = $("prevPage");
    const next = $("nextPage");
    if (prev) prev.onclick = () => { if (currentPage > 1) { currentPage--; render(pools); } };
    if (next) next.onclick = () => { if (currentPage < totalPages) { currentPage++; render(pools); } };
  }

  poolsCache = pools;
  previousPoolIds = new Set(pools.map((p) => p.pool));
  hadPrevious = true;

  $("statPools").textContent = visible.length.toLocaleString();
  $("statTokens").textContent = new Set(pools.flatMap((p) => [p.token0, p.token1])).size.toLocaleString();
  const maxBlock = pools.reduce((a, p) => Math.max(a, Number(p.blockNumber) || 0), 0);
  if (maxBlock) $("statBlock").textContent = maxBlock.toLocaleString();
  $("statScanned").textContent = pools.length.toLocaleString();
  $("statTime").textContent = new Date().toLocaleTimeString();
  $("progressText").textContent = `Live — ${pools.length} pools (updated ${new Date().toLocaleTimeString()})`;
  $("progressBar").style.width = "100%";
  $("rpcStatus").textContent = "Backend stream connected";
}

function formatUnits(raw, decimals) {
  try {
    const v = BigInt(raw);
    const s = v.toString();
    // simple decimal split
    let str = s;
    if (decimals > 0) {
      if (s.length <= decimals) str = "0." + s.padStart(decimals, "0");
      else str = s.slice(0, s.length - decimals) + "." + s.slice(s.length - decimals);
    }
    const n = Number(str);
    if (!isFinite(n)) return str;
    if (Math.abs(n) >= 1e9) return n.toExponential(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return String(raw);
  }
}

async function refresh() {
  try {
    currentPage = 1;
    const data = await fetchPools();
    render(data);
  } catch (e) {
    console.error(e);
    $("progressText").textContent = "Error: " + (e.message || e);
  }
}

function init() {
  const btn = $("loadBtn");
  if (btn) btn.addEventListener("click", refresh);
  const chainSelEl = $("chainSelect");
  if (chainSelEl) chainSelEl.addEventListener("change", () => { currentPage = 1; render(poolsCache); });
  const sel = $("protocolSelect");
  if (sel) sel.addEventListener("change", () => { currentPage = 1; render(poolsCache); });
  // SSE
  try {
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === "heartbeat") {
          if (msg.block) $("statBlock").textContent = Number(msg.block).toLocaleString();
          $("statTime").textContent = new Date(msg.time || Date.now()).toLocaleTimeString();
          $("progressText").textContent = `Live — ${poolsCache.length} pools (updated ${new Date(msg.time || Date.now()).toLocaleTimeString()})`;
          return;
        }
        if (msg && Array.isArray(msg.pools)) render(msg.pools);
      } catch {}
    };
    es.onerror = () => {
      $("rpcStatus").textContent = "Stream reconnecting…";
    };
  } catch {}
  refresh();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
