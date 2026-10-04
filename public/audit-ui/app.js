"use strict";

// Standalone simulation: no fetch, accounts, credentials, browser storage, or providers.
const companies = {
  DEMO: { name: "Thesis Example Systems", route: "General company", price: 40, cap: "$8.00B", sector: "Technology", revenue: "$12.50B", growth: "12.0%", key: "ROIC", keyValue: "26.0%", target: 48, grades: [["Fundamentals","A"],["Valuation","C"],["Technicals","B"],["Balance sheet","B"],["Quality","B"],["Leadership","B"],["Moat","A"]] },
  DBNK: { name: "Demonstration Community Bank", route: "Financials · bank", price: 25, cap: "$5.00B", sector: "Financial Services", revenue: "$8.00B", growth: "8.0%", key: "ROE", keyValue: "12.0%", target: null, grades: [["Fundamentals",null],["Valuation",null],["Technicals",null],["Balance sheet",null],["Quality",null],["Leadership",null],["Moat",null]] }
};
const state = { design: "current", symbol: "DEMO", page: "report", condition: "baseline", report: 42, ai: "none", model: "Demo model A", effort: "medium", speed: "standard", run: "idle", step: 0, compared: false, selectedScenario: "base", selectedGrade: null };
const app = document.querySelector("#app");
const notes = {
  current: "Current · simplified reproduction of the existing terminal UI. Compact density and existing information order; safety labels added for the simulation.",
  workspace: "Research workspace · evidence beside the report, readable type, and clear snapshot context. Best for checking a claim while reading; uses more horizontal space.",
  brief: "Decision brief · questions, disconfirming evidence, and unresolved gaps lead. Best for reviewing a thesis; detailed analysis takes another step."
};
const pages = [["dashboard","Overview"],["report","Saved report"],["analysis","Live analysis"],["evidence","Sources & gaps"],["history","History"],["settings","AI controls"]];
const money = value => value === null ? "Unavailable" : `$${value.toFixed(2)}`;
const announce = text => { document.querySelector("#announcement").textContent = text; };
const button = (action, label, extra = "") => `<button type="button" data-action="${action}" ${extra}>${label}</button>`;
const pill = (label, tone = "") => `<span class="pill ${tone}">${label}</span>`;
const panel = (title, body, right = "", id = "") => `<section class="panel" ${id ? `id="${id}"` : ""}><div class="panel-title"><h2>${title}</h2>${right}</div><div class="panel-body">${body}</div></section>`;
function data() {
  const c = companies[state.symbol];
  return { ...c, price: state.condition === "gaps" ? null : c.price - (state.report === 41 ? 2 : 0), target: state.condition === "gaps" ? null : c.target, quoteDate: state.condition === "stale" ? "2025-09-30" : state.report === 41 ? "2025-12-24" : "2025-12-31", aiMissing: state.condition === "dataonly" || state.symbol === "DBNK" };
}
function gapRows() {
  const rows = [{ field: "Next earnings date", reason: "Not supplied by the synthetic case. No date inferred.", impact: "Event timing cannot be assessed.", source: "Synthetic fixture · earnings" }];
  if (state.symbol === "DBNK") rows.push({ field: "Bank valuation target", reason: "No supported bank valuation snapshot in this comparison.", impact: "Target and valuation grade withheld; industrial DCF omitted.", source: "No source in demonstration" });
  if (state.condition === "gaps") rows.push({ field: "Quote and valuation inputs", reason: "Simulated provider failure; no current quote is available.", impact: "Price, target and upside withheld. Historical facts can still be read.", source: "Simulation · provider timeout" });
  if (state.condition === "stale") rows.push({ field: "Quote freshness", reason: "Quote snapshot is dated 2025-09-30.", impact: "Historical demonstration only; cannot support a current decision.", source: "Synthetic fixture · quote" });
  if (data().aiMissing) rows.push({ field: "analysis.llm", reason: state.symbol === "DBNK" ? "Bank case is data only in this comparison." : "Simulated AI connection failure; analyst assessment unavailable.", impact: "AI judgments, catalysts and qualitative grades withheld.", source: "Simulation · AI off / unavailable" });
  return rows;
}
function contextNotice() {
  const c = data();
  let text = "Synthetic financial values and invented research prose. Nothing here represents a real issuer or current market observation.";
  if (state.condition === "gaps") text += " Critical gaps: quote and valuation inputs are missing; unavailable results are withheld.";
  if (state.condition === "stale") text += " Stale quote scenario: retain the historical date and do not treat it as today’s price.";
  if (c.aiMissing) text += " Data-only report: unavailable analyst judgments do not establish that no risks exist.";
  return `<div class="notice">${pill(c.aiMissing ? "DATA ONLY · SIMULATION" : "SYNTHETIC DEMONSTRATION","warn")}<p>${text}</p></div>`;
}
function metric(label, value, date, source) { return `<div class="metric"><span class="eyebrow">${label}</span><strong>${value}</strong><small>${value === "Unavailable" ? "No usable observation" : `as of ${date}`}</small><small>${source}</small></div>`; }
function metrics() {
  const c = data();
  return `<div class="metrics">${metric("Snapshot price · USD",money(c.price),c.quoteDate,state.report === 41 ? "invented older snapshot" : "synthetic quote fixture")}${metric("Revenue · FY",c.revenue,"2025-12-31","synthetic statements")}${metric(c.key,c.keyValue,"2025-12-31","illustrative computed metric")}${metric("Valuation estimate · USD",money(c.target),"2025-12-31",c.target === null ? "withheld · see data gaps" : "synthetic DEMO report")}</div>`;
}
function claim(label, text, source, date = "2025-12-31") { return `<details class="claim"><summary>${pill(label)}${text} <span class="muted">· show source</span></summary><div class="source">Source: ${source}<br>As of: ${date}<br>Numeric tracing is provenance coverage; it does not establish correctness. All claims here are simulated.</div></details>`; }
function grades() {
  return `<div class="grade-strip" aria-label="Section grades">${data().grades.map(([label, grade]) => button("grade",`${grade && !data().aiMissing && state.condition !== "gaps" ? `<span class="grade ${grade === "C" ? "c" : ""}">${grade}</span>` : `<span class="pill">n/a</span>`}${label}`,`data-grade="${label}" aria-label="${label}: ${grade && !data().aiMissing && state.condition !== "gaps" ? `synthetic grade ${grade}` : "not assessed"}; show assessment context"`)).join("")}</div>`;
}
function assessmentContext() {
  if (!state.selectedGrade) return "";
  const grade = data().grades.find(([label])=>label===state.selectedGrade)?.[1];
  return panel(`${state.selectedGrade} · assessment context`,data().aiMissing || state.condition === "gaps" ? `<p>Assessment unavailable in this scenario. Missing evidence cannot support an affirmative grade.</p>` : `<p>Synthetic grade ${grade}. This chip illustrates the current report’s grade strip; detailed reasoning for this demonstration is limited to the fundamentals, valuation and risk sections below.</p><p class="footnote">Source: fictional DEMO sample / UI illustration · as of 2025-12-31. A grade is an assessment, not a recommendation.</p>`,"","assessment-context");
}
function fundamentals() {
  const c = data();
  return panel(state.design === "brief" ? "What supports the case?" : "Fundamentals & returns",
    claim("FACT",`Fictional FY revenue is ${c.revenue}. This is a contract demonstration.`,`fixtures/fmp/incomeStatement/${state.symbol}.json`)+
    claim("ESTIMATE",`${c.key} is ${c.keyValue} in this illustrative research case.`,"UI demonstration · invented analysis")+
    `<div class="table-wrap"><table><caption>Synthetic case summary · FY 2025 · USD unless stated</caption><thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Evidence date</th></tr></thead><tbody><tr><th scope="row">Revenue growth</th><td>${c.growth}</td><td>2025-12-31</td></tr><tr><th scope="row">Market cap</th><td>${c.cap}</td><td>${c.quoteDate}</td></tr><tr><th scope="row">Next earnings</th><td>Unavailable</td><td>No evidence date</td></tr></tbody></table></div>`,pill(c.route),"fundamentals");
}
function valuation() {
  const c = data();
  if (c.target === null) return panel("Valuation · assessment withheld",`<p>No supported target is available for this case. ${state.symbol === "DBNK" ? "A bank needs an appropriate bank valuation method; this demonstration does not apply an industrial DCF." : "Missing quote and valuation inputs prevent a supported target or upside calculation."}</p>${button("navigate","Inspect the missing-data manifest",'data-page="evidence"')}`,pill("UNAVAILABLE","warn"),"valuation");
  const target = { bull: 60, base: 48, bear: 30 }[state.selectedScenario];
  return panel(state.design === "brief" ? "What must be true at this valuation?" : "Valuation · scenario estimates",
    `<p>Base estimate ${money(c.target)} versus historical synthetic price ${money(c.price)}. These invented scenarios illustrate presentation, not a prediction.</p><div class="tabs" role="group" aria-label="Valuation scenario">${["bull","base","bear"].map(x => button("scenario",x,`data-scenario="${x}" aria-pressed="${state.selectedScenario === x}"`)).join("")}</div>`+
    `<p><strong>${state.selectedScenario.toUpperCase()} · ${money(target)}</strong> · illustrative 12-month scenario. ${state.selectedScenario === "bull" ? "Assumes durable growth and expanding margins." : state.selectedScenario === "bear" ? "Assumes slowing growth and multiple compression." : "Assumes stable margins and continued growth."}</p>`+
    `<div class="scenario-grid">${[["Bear",30],["Base",48],["Bull",60]].map(([label,value])=>`<div class="scenario">${label}<strong>${money(value)}</strong><small>USD · as of 2025-12-31<br>Illustrative estimate · no empirical probability</small></div>`).join("")}</div>`+
    claim("ESTIMATE","The base value is $48.00 per share in the synthetic DEMO report.","fixtures/report/DEMO-sample.json · valuation.dcf.perShare"),"","valuation");
}
function risks() {
  return panel(state.design === "brief" ? "What could break the thesis?" : "Catalysts, risks & open questions",
    data().aiMissing ? `<p>Not assessed. No completed AI assessment is available. An empty assessment does not establish that no risks exist.</p><p class="muted">Still unresolved: next earnings date and ${state.symbol === "DBNK" ? "bank valuation support" : "forward growth assumptions"}.</p>` :
    claim("JUDGMENT","The fictional growth case depends on sustained customer retention. Verify retention evidence before relying on this thesis.","UI demonstration · invented analyst judgment")+
    `<ul><li><strong>Disconfirming evidence:</strong> two periods of declining margins would weaken the fictional case.</li><li><strong>Unresolved:</strong> next earnings date is missing; no event timing inferred.</li><li><strong>Next research step:</strong> inspect the supporting statements and challenge assumptions.</li></ul>`,pill(data().aiMissing ? "NOT ASSESSED" : "SIMULATED JUDGMENT","warn"),"risks");
}
function evidenceSummary() {
  return `<aside class="evidence-rail" aria-label="Evidence context">${panel("Evidence at a glance",`<p><strong>Saved report #${state.report}</strong><br><span class="stamp">Generated ${state.report === 41 ? "2026-01-08" : "2026-01-15"} · synthetic snapshot</span></p><p class="stamp">Statements: 2025-12-31<br>Quote: ${data().quoteDate}<br>Fixture / simulation sources only</p><p class="footnote">${data().aiMissing ? "AI judgments unavailable." : "92% numeric citation coverage in the DEMO sample; tracing does not prove accuracy."}</p>${button("navigate","Open sources & gaps",'data-page="evidence"')}`)}${panel("Open data gaps",`<p>${gapRows().length} disclosed gaps</p><ul>${gapRows().map(r=>`<li>${r.field}</li>`).join("")}</ul>${button("navigate","Inspect history",'data-page="history"')}`)}</aside>`;
}
function runBox() {
  if (state.run === "idle") return "";
  const labels = ["Load synthetic data","Compute locally","Simulate analyst","Check citations"];
  return `<div class="run-box" aria-label="Simulated report progress"><strong>${state.run === "running" ? "Simulated run in progress" : state.run === "done" ? "Simulated report ready" : "Simulated run canceled"}</strong><ol>${labels.map((label,i)=>`<li>${label} · ${i < state.step ? "done" : i === state.step && state.run === "running" ? "running" : "pending"}</li>`).join("")}</ol><p class="footnote">Cost $0.00 · no provider calls · temporary memory only · AI ${state.ai === "none" ? "off" : "simulated"}</p>${state.run === "running" ? button("cancel","Cancel simulation") : button("generate","Run again")}</div>`;
}
function reportPage() {
  const title = state.design === "brief" ? `<p class="eyebrow">Research question · synthetic case</p><h2 class="question">${data().aiMissing ? "Which evidence is still missing?" : "Does durable growth justify the estimate?"}</h2>` : "";
  const ordered = state.design === "brief" ? risks()+valuation()+fundamentals() : fundamentals()+valuation()+risks();
  return `<div class="row">${pill(`SAVED SNAPSHOT #${state.report}`)}<span class="stamp">Generated ${state.report === 41 ? "2026-01-08" : "2026-01-15"} · no current data</span></div>${contextNotice()}${title}${metrics()}${grades()}${assessmentContext()}<div class="section-nav"><a href="#fundamentals">Fundamentals</a><a href="#valuation">Valuation</a><a href="#risks">Risks & questions</a></div><div class="research-grid"><div class="stack">${ordered}</div>${evidenceSummary()}</div>`;
}
function evidencePage() {
  return `${contextNotice()}${panel("Missing-data manifest",`<div class="table-wrap"><table><caption>Gaps affect what can be assessed; unavailable never means zero.</caption><thead><tr><th scope="col">Field</th><th scope="col">Reason / attempted source</th><th scope="col">Effect on research</th></tr></thead><tbody>${gapRows().map(r=>`<tr><th scope="row">${r.field}</th><td>${r.reason}<br><span class="stamp">${r.source}</span></td><td>${r.impact}</td></tr>`).join("")}</tbody></table></div>`)}<div class="stack">${panel("Provenance ledger",`<p>Quote/profile values follow the bundled fictional DEMO / DBNK fixtures. Descriptive research prose, bank metrics, and historical deltas are invented for this UI lab.</p>${claim("FACT",`Historical price: ${money(data().price)}.`,`fixtures/fmp/quote/${state.symbol}.json`,data().quoteDate)}${claim("FACT",`Company: ${companies[state.symbol].name}.`,`fixtures/fmp/profile/${state.symbol}.json`)}<p class="footnote">The lab intentionally freezes dates. Generated-at time and evidence-as-of time are different concepts.</p>`)}</div>`;
}
function analysisPage() {
  return `${contextNotice()}<div class="notice">Live-analysis workflow · simulated<p>This pane stands for a newly built bundle. This lab stays on fixed synthetic dates and does not fetch live data.</p></div>${metrics()}${panel("Price history · illustrative",`<svg class="chart" viewBox="0 0 560 155" role="img" aria-labelledby="chart-title"><title id="chart-title">Invented price illustration ending at ${state.symbol === "DEMO" ? "$40" : "$25"}; use the data table for exact values</title><path d="M35 20V125H540" fill="none" stroke="currentColor" opacity=".3"/><polyline points="35,112 130,90 225,102 320,63 415,58 515,35" fill="none" stroke="currentColor" stroke-width="3"/><text x="35" y="148">Jan 2025</text><text x="440" y="148">Dec 2025</text></svg><details><summary>View accessible chart data · invented illustration</summary><div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Synthetic close · USD</th></tr></thead><tbody>${["2025-01-31","2025-03-31","2025-06-30","2025-09-30","2025-11-30","2025-12-31"].map((date,i)=>`<tr><th scope="row">${date}</th><td>${money(companies[state.symbol].price * [.72,.82,.78,.90,.93,1][i])}</td></tr>`).join("")}</tbody></table></div></details><p class="footnote">Chart is an illustrative trend, not a scaled analytical figure. Exact values above are invented.</p>`)}<div class="stack">${fundamentals()}${valuation()}</div>`;
}
function historyPage() {
  return `${panel("Compare saved snapshots",`<p>Same fictional entity, older → newer. This demonstration labels source dates and model context.</p><div class="form-grid settings-note"><label>Older report<select id="older"><option value="41">#41 · 2026-01-08 · synthetic fixture</option><option value="42">#42 · 2026-01-15 · synthetic fixture</option></select></label><label>Newer report<select id="newer"><option value="42">#42 · 2026-01-15 · synthetic fixture</option><option value="41">#41 · 2026-01-08 · synthetic fixture</option></select></label></div>${button("compare","Compare snapshots")}<div id="comparison-result">${state.compared ? comparison() : ""}</div>`)}${panel("Saved reports · simulation",`<div class="table-wrap"><table><caption>Two invented saved runs. Opening a run changes the snapshot label.</caption><thead><tr><th scope="col">Run</th><th scope="col">Generated · UTC</th><th scope="col">Model / cost</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${[[42,"2026-01-15"],[41,"2026-01-08"]].map(([id,date])=>`<tr><th scope="row">#${id}</th><td>${date} 12:00</td><td>synthetic fixture · $0.00</td><td>${data().aiMissing ? "Data only" : "Demo complete"}</td><td>${button("open-report","Open snapshot",`data-report="${id}"`)}</td></tr>`).join("")}</tbody></table></div>`)}`;
}
function comparison() { return `<div class="notice">Illustrative change · #41 → #42<p>Quote changed from ${money(companies[state.symbol].price - 2)} to ${money(companies[state.symbol].price)} in an invented historical example. Target ${state.symbol === "DBNK" ? "remains unavailable" : "is unchanged at $48.00"}. Both snapshots have statement evidence dated 2025-12-31. No conclusion about investment merit follows from a numeric change.</p></div>`; }
function settingsPage() {
  return `${panel("AI research controls · simulation",`<p>Financial calculations and citation tracing remain deterministic. All options below are pretend connections; no sign-in or report requests are sent.</p><p class="settings-note">${pill(`ACTIVE · ${state.ai === "none" ? "AI OFF / DATA ONLY" : state.ai.toUpperCase() + " SIMULATION"}`)}</p><div class="form-grid"><label>Provider<select id="ai"><option value="none" ${state.ai === "none" ? "selected" : ""}>AI off · data-only reports</option><option value="chatgpt" ${state.ai === "chatgpt" ? "selected" : ""}>ChatGPT plan · simulated account</option><option value="gemini" ${state.ai === "gemini" ? "selected" : ""}>Gemini CLI · simulated account</option><option value="claude" ${state.ai === "claude" ? "selected" : ""}>Claude API · separately billed in real app</option></select></label><label>Model<select id="model"><option ${state.model === "Demo model A" ? "selected" : ""}>Demo model A</option><option ${state.model === "Demo model B" ? "selected" : ""}>Demo model B</option></select></label><label>Reasoning effort<select id="effort">${["low","medium","high"].map(v=>`<option ${state.effort === v ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>Speed<select id="speed"><option value="standard" ${state.speed === "standard" ? "selected" : ""}>Standard</option><option value="fast" ${state.speed === "fast" ? "selected" : ""}>Fast · higher allowance use in real app</option></select></label></div><p class="settings-note">${button("save-ai","Apply to simulated new runs")}</p><p id="settings-status" role="status"></p><p class="footnote">Applied only in memory. Selecting a provider does not generate a report. No fallback to paid API. Real allowance and model access would need provider confirmation.</p>`)}${panel("Data-source access",`<p>${pill("FIXTURES ONLY","warn")}No API keys, contact details, real accounts, or personal data are accepted by this demo.</p>`)}`;
}
function dashboardPage() {
  return `<h2>Research overview</h2>${contextNotice()}${panel("Watchlist · synthetic",`<div class="table-wrap"><table><thead><tr><th scope="col">Company</th><th scope="col">Historical price</th><th scope="col">Evidence date</th><th scope="col">Report</th></tr></thead><tbody>${Object.entries(companies).map(([symbol,c])=>`<tr><th scope="row">${symbol}<br><span class="stamp">${c.name}</span></th><td>${money(c.price)} USD</td><td>2025-12-31 · fixture</td><td>${button("company","Open research",`data-symbol="${symbol}"`)}</td></tr>`).join("")}</tbody></table></div>`)}${panel("Research readiness",`<p>DEMO contains an illustrative full report. DBNK demonstrates a bank route with unavailable assessment and target. No current market data is available.</p><div class="actions settings-note">${button("navigate","Review AI controls",'data-page="settings"')}${button("navigate","Review sources & gaps",'data-page="evidence"')}</div>`)}`;
}
function render(focus = false) {
  const focusedAction = document.activeElement?.dataset?.action;
  const c = data();
  app.dataset.design = state.design;
  document.querySelector("#design-note").textContent = notes[state.design];
  document.querySelectorAll("[data-design]").forEach(el => { if (el.tagName === "BUTTON") el.setAttribute("aria-pressed",String(el.dataset.design === state.design)); });
  const pageTitle = pages.find(([id])=>id===state.page)[1];
  app.innerHTML = `<div class="topbar"><strong class="brand">THESIS</strong><small>${state.design === "workspace" ? "Research workspace" : state.design === "brief" ? "Decision brief" : "Equity research engine"} · interface simulation</small>${button("navigate","AI controls",'data-page="settings"')}</div><div class="frame"><aside class="sidebar" aria-label="Research navigation"><div class="eyebrow">Watchlist · 2 fictional tickers</div><div class="watchlist">${Object.entries(companies).map(([symbol,item])=>button("company",`<strong>${symbol}</strong><span>${item.name}</span><span>${money(item.price)} USD · as of 2025-12-31</span>`,`class="watch-button" data-symbol="${symbol}" aria-pressed="${state.symbol === symbol}"`)).join("")}</div><nav class="nav" aria-label="Demo pages">${pages.map(([id,label])=>button("navigate",label,`data-page="${id}" ${state.page===id ? 'aria-current="page"' : ""}`)).join("")}</nav><p class="footnote">Synthetic fixtures. Historical dates. No provider connections or saved preferences.</p></aside><main class="content" id="content" tabindex="-1"><div class="company-head"><div><span class="eyebrow">${pageTitle}</span><h1>${state.symbol} <span class="muted">${c.name}</span></h1><p>${c.route} · fictional company · USD</p></div><div class="actions">${button("generate",state.run === "running" ? "Running simulation…" : "Simulate report run",state.run === "running" ? "disabled" : "")}${button("export-md","Export demo MD")}${button("export-pdf","Preview PDF")}</div></div>${runBox()}${state.page === "report" ? reportPage() : state.page === "analysis" ? analysisPage() : state.page === "evidence" ? evidencePage() : state.page === "history" ? historyPage() : state.page === "settings" ? settingsPage() : dashboardPage()}</main></div><footer class="footer">Informational only — not investment advice. All values and interactions in this interface lab are synthetic / simulated.</footer>`;
  if (focus) document.querySelector("#content").focus({ preventScroll: true });
  else if (focusedAction) app.querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}
function exportText() {
  const c = data();
  return `# THESIS · SYNTHETIC UI DEMONSTRATION\n\n${state.symbol} — ${c.name}\nReport snapshot #${state.report} · generated ${state.report === 41 ? "2026-01-08" : "2026-01-15"}\nCondition: ${state.condition}\n\nAll data are invented. No real issuer / current market observation.\nInformational only — not investment advice.\n\n## Historical case\nPrice: ${money(c.price)} USD · as of ${c.quoteDate}\nRevenue: ${c.revenue} · FY as of 2025-12-31\n${c.key}: ${c.keyValue} · as of 2025-12-31 · illustrative computed metric\nTarget estimate: ${money(c.target)} USD · as of 2025-12-31\nAI assessment: ${c.aiMissing ? "unavailable / data only" : "synthetic demonstration only"}\n\n## Sources\nQuote/profile: bundled fixtures/fmp/*/${state.symbol}.json\nDEMO target: fixtures/report/DEMO-sample.json\nOther analytical prose / historical deltas / bank metrics: invented UI illustration\nCitation tracing indicates provenance, not correctness.\n\n## Missing data\n${gapRows().map(r=>`- ${r.field}: ${r.reason} Effect: ${r.impact}`).join("\n")}\n\n## Simulation settings\nProvider: ${state.ai} · Model: ${state.model}\nEffort: ${state.effort} · Speed: ${state.speed}\nCost: $0.00 · No provider requests. Settings exist only in memory.\n`;
}
let runTimer;
function generate() {
  clearInterval(runTimer); state.run = "running"; state.step = 0; render(); announce("Simulated report started. No providers are contacted.");
  runTimer = setInterval(()=>{ state.step++; if (state.step === 4) { clearInterval(runTimer); state.run = "done"; announce("Simulated report complete. No data was persisted."); } render(); },850);
}
document.querySelectorAll("button[data-design]").forEach(el=>el.addEventListener("click",()=>{ state.design = el.dataset.design; render(); announce(`Design changed to ${state.design}. Same synthetic case retained.`); }));
document.querySelector("#condition").addEventListener("change",e=>{ state.condition = e.target.value; render(); announce(`Data condition: ${e.target.selectedOptions[0].textContent}`); });
app.addEventListener("click",e=>{
  const el = e.target.closest("button[data-action]"); if (!el) return;
  const action = el.dataset.action;
  if (action === "navigate") { state.page = el.dataset.page; render(true); announce(`${state.page} opened.`); }
  if (action === "company") { state.symbol = el.dataset.symbol; state.page = "report"; state.report = 42; state.compared = false; render(true); announce(`${state.symbol} synthetic report opened.`); }
  if (action === "grade") { state.selectedGrade = el.dataset.grade; render(); document.getElementById("assessment-context")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); announce(`${state.selectedGrade} assessment context opened.`); }
  if (action === "scenario") { state.selectedScenario = el.dataset.scenario; render(); const selected = app.querySelector(`[data-scenario="${state.selectedScenario}"]`); selected?.focus({preventScroll:true}); announce(`Illustrative ${state.selectedScenario} scenario selected.`); }
  if (action === "generate") generate();
  if (action === "cancel") { clearInterval(runTimer); state.run = "canceled"; render(); announce("Simulated run canceled."); }
  if (action === "open-report") { state.report = Number(el.dataset.report); state.page = "report"; render(true); announce(`Synthetic snapshot ${state.report} opened. Values are intentionally fixed for layout comparison.`); }
  if (action === "compare") {
    const a = document.querySelector("#older").value, b = document.querySelector("#newer").value;
    if (a === b) { document.querySelector("#comparison-result").textContent = "Choose two different report snapshots."; announce("Choose two different report snapshots."); }
    else { state.compared = true; document.querySelector("#comparison-result").innerHTML = comparison(); announce("Illustrative comparison opened, ordered older to newer."); }
  }
  if (action === "save-ai") { state.ai = document.querySelector("#ai").value; state.model = document.querySelector("#model").value; state.effort = document.querySelector("#effort").value; state.speed = document.querySelector("#speed").value; render(); document.querySelector("#settings-status").textContent = "Simulation settings applied in memory. Nothing saved or sent. Saved report snapshots remain unchanged."; announce("Simulation settings applied. Nothing saved or sent."); }
  if (action === "export-md") { const blob = new Blob([exportText()],{type:"text/markdown;charset=utf-8"}); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `THESIS-SYNTHETIC-${state.symbol}-${state.condition}.md`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),3000); announce("Synthetic Markdown download requested."); }
  if (action === "export-pdf") { document.querySelector("#export-preview").textContent = exportText(); document.querySelector("#export-dialog").showModal(); }
});
document.querySelector("#close-export").addEventListener("click",()=>document.querySelector("#export-dialog").close());
document.querySelector("#print-export").addEventListener("click",()=>window.print());
render();
