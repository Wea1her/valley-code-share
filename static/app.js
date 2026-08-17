const state = {
  bootstrap: null,
  activity: null,
  feedbackClaim: null,
  formStartedAt: Date.now() / 1000,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function visitorId() {
  let value = localStorage.getItem("valley.visitor");
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("valley.visitor", value);
  }
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Visitor-ID": visitorId(),
      ...(options.headers || {}),
    },
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* empty */ }
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试");
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
}

function formatDate(value) {
  if (!value) return "时间待定";
  return new Intl.DateTimeFormat("zh-CN", {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"}).format(new Date(value));
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
}

function statusLabel(status) {
  return ({active:"进行中", upcoming:"即将开始", paused:"暂时暂停", ended:"已结束"})[status] || status;
}

async function loadHome() {
  try {
    state.bootstrap = await api("/api/bootstrap");
    const settings = state.bootstrap.settings;
    document.title = settings.site_name;
    $("#siteName").textContent = settings.site_name;
    $("#siteNotice").textContent = settings.site_notice;
    configureSponsor(settings);
    renderActivities(state.bootstrap.activities);
  } catch (error) {
    $("#activitySections").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function configureSponsor(settings) {
  $$(".sponsor-trigger").forEach((button) => button.classList.toggle("hidden", !settings.sponsor_enabled));
  $("#sponsorTitle").textContent = settings.sponsor_title || "赞助作者";
  $("#sponsorText").textContent = settings.sponsor_text || "";
  const qr = $("#sponsorQr");
  qr.classList.toggle("hidden", !settings.sponsor_qr);
  if (settings.sponsor_qr) qr.src = settings.sponsor_qr;
}

function renderActivities(activities) {
  const groups = [
    ["active", "正在进行", "现在就能参与的互助活动"],
    ["upcoming", "即将开始", "提前了解活动时间和规则"],
    ["paused", "暂时暂停", "活动规则调整或异常处理完成后恢复"],
    ["ended", "往期活动", "只保留匿名汇总，不再提供口令"],
  ];
  const html = groups.map(([key, title, subtitle]) => {
    const items = activities.filter((activity) => activity.public_state === key);
    if (!items.length && key !== "active") return "";
    return `<section>
      <div class="section-heading"><div><span class="eyebrow">${statusLabel(key)}</span><h2>${title}</h2></div><p>${subtitle}</p></div>
      ${items.length ? `<div class="activity-grid">${items.map(activityCard).join("")}</div>` : `<div class="empty-state">当前还没有公开活动。管理员发布活动后会出现在这里。</div>`}
    </section>`;
  }).join("");
  $("#activitySections").innerHTML = html;
  $$("[data-activity-id]").forEach((card) => card.addEventListener("click", () => openActivity(Number(card.dataset.activityId))));
}

function activityCard(activity) {
  const canOpen = activity.public_state !== "ended";
  return `<article class="activity-card" data-activity-id="${activity.id}" tabindex="0" role="button" aria-label="查看${escapeHtml(activity.title)}">
    <div class="card-top"><span class="status-badge status-${activity.public_state}">${statusLabel(activity.public_state)}</span><span>${canOpen ? "进入活动 →" : "查看回顾 →"}</span></div>
    <h3>${escapeHtml(activity.title)}</h3>
    <p>${escapeHtml(activity.summary || "活动详情由管理员维护。")}</p>
    <div class="card-stats"><div><strong>${activity.available_codes || 0}</strong><small>可用口令</small></div><div><strong>${activity.available_claims || 0}</strong><small>剩余机会</small></div></div>
    <div class="card-bottom"><span>${formatDate(activity.starts_at)}</span><span>${activity.ends_at ? `至 ${formatDate(activity.ends_at)}` : "长期活动"}</span></div>
  </article>`;
}

async function openActivity(id) {
  $("#homeView").classList.add("hidden");
  $("#activityView").classList.remove("hidden");
  $("#activityContent").innerHTML = '<div class="loading-card">正在进入口令池…</div>';
  history.replaceState(null, "", `#activity=${id}`);
  window.scrollTo({top: 0, behavior: "smooth"});
  try {
    const payload = await api(`/api/activities/${id}`);
    state.activity = payload.activity;
    renderActivity(payload.activity, payload.settings);
  } catch (error) {
    $("#activityContent").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function rewardRange(tier, unit) {
  if (tier.min_value == null && tier.max_value == null) return unit;
  if (tier.max_value == null) return `${tier.min_value}+ ${unit}`;
  if (tier.min_value == null) return `≤ ${tier.max_value} ${unit}`;
  return `${tier.min_value}–${tier.max_value} ${unit}`;
}

function renderActivity(activity, settings) {
  const active = activity.public_state === "active";
  const totalClaims = activity.tiers.reduce((sum, tier) => sum + Number(tier.available_claims || 0), 0);
  const scopeOptions = activity.scopes.map((scope) => `<option value="${scope.id}">${escapeHtml(scope.label)}</option>`).join("");
  const tiers = activity.tiers.map((tier) => `<article class="tier-card">
    <div><h3>${escapeHtml(tier.name)}</h3><p>${activity.reward_mode === "numeric" ? rewardRange(tier, activity.reward_unit) : `该档位由活动管理员配置`}</p>
      <div class="tier-metrics"><span><strong>${tier.available_codes}</strong> 个口令</span><span><strong>${tier.available_claims}</strong> 次机会</span><span>${tier.success_rate == null ? "反馈不足" : `成功率 ${tier.success_rate}%`}</span></div>
    </div>
    <button class="primary-button claim-button" data-tier="${tier.id}" type="button" ${!active || tier.available_claims <= 0 ? "disabled" : ""}>${active ? (tier.available_claims > 0 ? "复制一个口令" : "暂时领完") : statusLabel(activity.public_state)}</button>
  </article>`).join("");
  $("#activityContent").innerHTML = `
    <section class="activity-hero">
      <div class="activity-hero-row"><div><span class="status-badge status-${activity.public_state}">${statusLabel(activity.public_state)}</span><h1>${escapeHtml(activity.title)}</h1><p>${escapeHtml(activity.description || activity.summary)}</p>
        <div class="activity-meta"><span>开始 ${formatDate(activity.starts_at)}</span><span>结束 ${formatDate(activity.ends_at)}</span><span>每个口令 ${activity.code_capacity} 次</span><span>每日可领 ${activity.daily_claim_browser} 个</span></div>
      </div><div class="activity-summary-number"><strong>${totalClaims}</strong><small>预计剩余领取机会</small></div></div>
    </section>
    <div class="pool-layout">
      <section class="panel"><div class="panel-head"><div><span class="eyebrow">自动分配</span><h2>选择奖励档位</h2><p>系统优先分配剩余次数较少的口令。</p></div></div>
        ${activity.scopes.length ? `<div class="scope-row"><label for="claimScope">选择适用范围</label><select id="claimScope"><option value="">请选择</option>${scopeOptions}</select></div>` : ""}
        <div class="tier-list">${tiers || '<div class="empty-state">管理员尚未配置奖励档位。</div>'}</div>
        <label class="check-row"><input id="claimNotice" type="checkbox" ${localStorage.getItem("valley.claimNotice") ? "checked" : ""}><span>${escapeHtml(settings.claim_notice)}</span></label>
        <div class="info-strip">只有剪贴板确认复制成功后才会占用1次。同一浏览器再次复制领取记录中的口令不会重复扣减。</div>
      </section>
      <aside class="panel submit-panel"><div class="panel-head"><div><span class="eyebrow">贡献口令</span><h2>分享你的口令</h2><p>新口令会先进入待验证池。</p></div></div>${active ? submitForm(activity, settings) : `<div class="empty-state">这个活动当前不能提交口令。</div>`}</aside>
    </div>`;

  $$(".claim-button").forEach((button) => button.addEventListener("click", () => claimCode(Number(button.dataset.tier), button)));
  $("#submitCodeForm")?.addEventListener("submit", submitCode);
  $("#claimNotice")?.addEventListener("change", (event) => {
    if (event.target.checked) localStorage.setItem("valley.claimNotice", "1"); else localStorage.removeItem("valley.claimNotice");
  });
  state.formStartedAt = Date.now() / 1000;
}

function submitForm(activity, settings) {
  let rewardField = "";
  if (activity.reward_mode === "numeric") {
    rewardField = `<div class="field"><label for="rewardValue">准确奖励数值</label><input id="rewardValue" name="reward_value" type="number" min="0" step="any" required placeholder="例如 614"><small>系统会自动归入对应档位</small></div>`;
  } else if (activity.reward_mode === "options") {
    rewardField = `<div class="field"><label for="rewardOption">奖励内容</label><select id="rewardOption" name="reward_option_id" required><option value="">请选择</option>${activity.reward_options.map((option) => `<option value="${option.id}">${escapeHtml(option.label)}</option>`).join("")}</select></div>`;
  }
  return `<form id="submitCodeForm">
    <div class="field"><label for="codeInput">口令</label><input id="codeInput" name="code" maxlength="64" autocomplete="off" required placeholder="输入完整口令"></div>
    ${rewardField}
    ${activity.scopes.length ? `<div class="field"><label for="submitScope">适用范围</label><select id="submitScope" name="scope_id" required><option value="">请选择</option>${activity.scopes.map((scope) => `<option value="${scope.id}">${escapeHtml(scope.label)}</option>`).join("")}</select></div>` : ""}
    <label class="honeypot" aria-hidden="true">网站<input name="website" tabindex="-1" autocomplete="off"></label>
    <label class="check-row"><input name="terms_accepted" type="checkbox" ${localStorage.getItem("valley.terms") ? "checked" : ""} required><span>${escapeHtml(settings.terms)}</span></label>
    <button class="primary-button" type="submit">提交到互助池</button>
  </form>`;
}

async function claimCode(tierId, button) {
  const notice = $("#claimNotice");
  if (!notice?.checked) return toast("请先确认领取提示");
  const scope = $("#claimScope");
  if (scope && !scope.value) return toast("请先选择适用范围");
  button.disabled = true;
  button.textContent = "正在分配…";
  let reservation = null;
  try {
    reservation = await api(`/api/activities/${state.activity.id}/claim`, {
      method: "POST",
      body: JSON.stringify({tier_id: tierId, scope_id: scope?.value || null, notice_accepted: true}),
    });
    const copied = await copyText(reservation.code);
    if (!copied) throw new Error("浏览器未能复制口令，请允许剪贴板权限后重试");
    await api(`/api/claims/${reservation.claim_id}/confirm`, {method:"POST", body:JSON.stringify({claim_token: reservation.claim_token})});
    saveClaim({...reservation, activity_id: state.activity.id, activity_title: state.activity.title, tier_id: tierId, created_at: new Date().toISOString()});
    state.feedbackClaim = reservation;
    $("#copiedCode").textContent = reservation.code;
    $("#feedbackDialog").showModal();
    await refreshActivity();
  } catch (error) {
    if (reservation) {
      try { await api(`/api/claims/${reservation.claim_id}/cancel`, {method:"POST", body:JSON.stringify({claim_token: reservation.claim_token})}); } catch (_) { /* cleanup expires */ }
    }
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "复制一个口令";
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const result = document.execCommand("copy");
    textarea.remove();
    return result;
  }
}

function saveClaim(claim) {
  const claims = JSON.parse(localStorage.getItem("valley.claims") || "[]");
  claims.unshift(claim);
  localStorage.setItem("valley.claims", JSON.stringify(claims.slice(0, 100)));
}

async function submitCode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  const data = Object.fromEntries(new FormData(form).entries());
  data.terms_accepted = Boolean(form.elements.terms_accepted.checked);
  data.form_started_at = state.formStartedAt;
  button.disabled = true;
  button.textContent = "正在提交…";
  try {
    const result = await api(`/api/activities/${state.activity.id}/codes`, {method:"POST", body:JSON.stringify(data)});
    const owners = JSON.parse(localStorage.getItem("valley.owners") || "[]");
    owners.unshift({id: result.id, token: result.owner_token});
    localStorage.setItem("valley.owners", JSON.stringify(owners.slice(0, 100)));
    localStorage.setItem("valley.terms", "1");
    form.reset();
    form.elements.terms_accepted.checked = true;
    state.formStartedAt = Date.now() / 1000;
    toast("提交成功，口令已进入待验证池");
    await refreshActivity();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "提交到互助池";
  }
}

async function refreshActivity() {
  if (!state.activity) return;
  const payload = await api(`/api/activities/${state.activity.id}`);
  state.activity = payload.activity;
  renderActivity(payload.activity, payload.settings);
}

async function sendFeedback(type) {
  if (!state.feedbackClaim) return;
  try {
    await api(`/api/claims/${state.feedbackClaim.claim_id}/feedback`, {method:"POST", body:JSON.stringify({claim_token:state.feedbackClaim.claim_token, feedback:type})});
    const claims = JSON.parse(localStorage.getItem("valley.claims") || "[]");
    const record = claims.find((item) => item.claim_id === state.feedbackClaim.claim_id);
    if (record) record.feedback = type;
    localStorage.setItem("valley.claims", JSON.stringify(claims));
    $("#feedbackDialog").close();
    toast("感谢反馈，已更新口令状态");
    await refreshActivity();
  } catch (error) { toast(error.message); }
}

async function openHistory(tab = "claims") {
  $("#historyDialog").showModal();
  $$(".tab").forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
  const content = $("#historyContent");
  if (tab === "claims") {
    const claims = JSON.parse(localStorage.getItem("valley.claims") || "[]");
    content.innerHTML = claims.length ? `<div class="history-list">${claims.map((item) => `<article class="history-item"><div class="history-item-head"><strong>${escapeHtml(item.activity_title)}</strong><span class="history-meta">${formatDate(item.created_at)}</span></div><div class="history-code">${escapeHtml(item.code)}</div><div class="history-meta">${item.scope_label ? escapeHtml(item.scope_label) : "全平台"} · ${item.feedback ? `已反馈：${feedbackLabel(item.feedback)}` : "尚未反馈"}</div><div class="mini-actions"><button class="text-button copy-history" data-code="${escapeHtml(item.code)}" type="button">再次复制</button>${!item.feedback ? `<button class="text-button history-feedback" data-id="${item.claim_id}" type="button">反馈结果</button>` : ""}</div></article>`).join("")}</div>` : '<div class="empty-state">当前浏览器还没有领取记录。</div>';
    $$(".copy-history", content).forEach((button) => button.addEventListener("click", async () => toast(await copyText(button.dataset.code) ? "已再次复制，不会重复扣次数" : "复制失败")));
    $$(".history-feedback", content).forEach((button) => button.addEventListener("click", () => {
      const claim = claims.find((item) => item.claim_id === Number(button.dataset.id));
      if (!claim) return;
      state.feedbackClaim = claim;
      $("#historyDialog").close();
      $("#copiedCode").textContent = claim.code;
      $("#feedbackDialog").showModal();
    }));
  } else {
    content.innerHTML = '<div class="loading-card">正在读取提交记录…</div>';
    const owners = JSON.parse(localStorage.getItem("valley.owners") || "[]");
    try {
      const result = await api("/api/my/submissions", {method:"POST", body:JSON.stringify({owner_tokens: owners.map((item) => item.token)})});
      content.innerHTML = result.items.length ? `<div class="history-list">${result.items.map((item) => `<article class="history-item"><div class="history-item-head"><strong>${escapeHtml(item.activity_title)}</strong><span class="status-badge">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.tier_name || item.reward_label || "活动奖励")} ${item.scope_label ? `· ${escapeHtml(item.scope_label)}` : ""}</p><div class="history-meta">剩余 ${item.remaining}/${item.capacity} 次 · ${formatDate(item.created_at)}</div>${!["withdrawn","expired"].includes(item.status) ? `<div class="mini-actions"><button class="text-button withdraw-code" data-id="${item.id}" type="button">撤回口令</button></div>` : ""}</article>`).join("")}</div>` : '<div class="empty-state">当前浏览器还没有提交记录。</div>';
      $$(".withdraw-code", content).forEach((button) => button.addEventListener("click", async () => {
        const owner = owners.find((item) => item.id === Number(button.dataset.id));
        if (!owner || !confirm("确定撤回这个口令吗？撤回后不会再次分配。")) return;
        try { await api(`/api/codes/${owner.id}/withdraw`, {method:"POST", body:JSON.stringify({owner_token:owner.token})}); toast("口令已撤回"); openHistory("submissions"); } catch (error) { toast(error.message); }
      }));
    } catch (error) { content.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
  }
}

function feedbackLabel(value) { return ({success:"兑换成功", invalid:"无效或已满", mismatch:"奖励不符"})[value] || value; }

function showHome() {
  state.activity = null;
  history.replaceState(null, "", location.pathname);
  $("#activityView").classList.add("hidden");
  $("#homeView").classList.remove("hidden");
  window.scrollTo({top:0, behavior:"smooth"});
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadHome();
  const match = location.hash.match(/activity=(\d+)/);
  if (match) openActivity(Number(match[1]));
  $("#brandButton").addEventListener("click", showHome);
  $("#backButton").addEventListener("click", showHome);
  $("#historyButton").addEventListener("click", () => openHistory("claims"));
  $$(".sponsor-trigger").forEach((button) => button.addEventListener("click", () => $("#sponsorDialog").showModal()));
  $$(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $$(".tab").forEach((button) => button.addEventListener("click", () => openHistory(button.dataset.tab)));
  $$("[data-feedback]").forEach((button) => button.addEventListener("click", () => sendFeedback(button.dataset.feedback)));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") $$("dialog[open]").forEach((dialog) => dialog.close()); });
});
