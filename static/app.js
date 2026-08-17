(() => {
  // src/app.ts
  var state = {
    bootstrap: null,
    activity: null,
    feedbackClaim: null,
    formStartedAt: Date.now() / 1e3
  };
  var $ = (selector, root = document) => root.querySelector(selector);
  var $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
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
        ...options.headers || {}
      }
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
    }
    if (!response.ok) throw new Error(payload.error || "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    return payload;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }
  function formatDate(value) {
    if (!value) return "\u65F6\u95F4\u5F85\u5B9A";
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }
  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
  }
  function statusLabel(status) {
    return { active: "\u8FDB\u884C\u4E2D", upcoming: "\u5373\u5C06\u5F00\u59CB", paused: "\u6682\u65F6\u6682\u505C", ended: "\u5DF2\u7ED3\u675F" }[status] || status;
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
    $("#sponsorTitle").textContent = settings.sponsor_title || "\u8D5E\u52A9\u4F5C\u8005";
    $("#sponsorText").textContent = settings.sponsor_text || "";
    const qr = $("#sponsorQr");
    qr.classList.toggle("hidden", !settings.sponsor_qr);
    if (settings.sponsor_qr) qr.src = settings.sponsor_qr;
  }
  function renderActivities(activities) {
    const groups = [
      ["active", "\u6B63\u5728\u8FDB\u884C", "\u73B0\u5728\u5C31\u80FD\u53C2\u4E0E\u7684\u4E92\u52A9\u6D3B\u52A8"],
      ["upcoming", "\u5373\u5C06\u5F00\u59CB", "\u63D0\u524D\u4E86\u89E3\u6D3B\u52A8\u65F6\u95F4\u548C\u89C4\u5219"],
      ["paused", "\u6682\u65F6\u6682\u505C", "\u6D3B\u52A8\u89C4\u5219\u8C03\u6574\u6216\u5F02\u5E38\u5904\u7406\u5B8C\u6210\u540E\u6062\u590D"],
      ["ended", "\u5F80\u671F\u6D3B\u52A8", "\u53EA\u4FDD\u7559\u533F\u540D\u6C47\u603B\uFF0C\u4E0D\u518D\u63D0\u4F9B\u53E3\u4EE4"]
    ];
    const html = groups.map(([key, title, subtitle]) => {
      const items = activities.filter((activity) => activity.public_state === key);
      if (!items.length && key !== "active") return "";
      return `<section>
      <div class="section-heading"><div><span class="eyebrow">${statusLabel(key)}</span><h2>${title}</h2></div><p>${subtitle}</p></div>
      ${items.length ? `<div class="activity-grid">${items.map(activityCard).join("")}</div>` : `<div class="empty-state">\u5F53\u524D\u8FD8\u6CA1\u6709\u516C\u5F00\u6D3B\u52A8\u3002\u7BA1\u7406\u5458\u53D1\u5E03\u6D3B\u52A8\u540E\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002</div>`}
    </section>`;
    }).join("");
    $("#activitySections").innerHTML = html;
    $$("[data-activity-id]").forEach((card) => card.addEventListener("click", () => openActivity(Number(card.dataset.activityId))));
  }
  function activityCard(activity) {
    const canOpen = activity.public_state !== "ended";
    return `<article class="activity-card" data-activity-id="${activity.id}" tabindex="0" role="button" aria-label="\u67E5\u770B${escapeHtml(activity.title)}">
    <div class="card-top"><span class="status-badge status-${activity.public_state}">${statusLabel(activity.public_state)}</span><span>${canOpen ? "\u8FDB\u5165\u6D3B\u52A8 \u2192" : "\u67E5\u770B\u56DE\u987E \u2192"}</span></div>
    <h3>${escapeHtml(activity.title)}</h3>
    <p>${escapeHtml(activity.summary || "\u6D3B\u52A8\u8BE6\u60C5\u7531\u7BA1\u7406\u5458\u7EF4\u62A4\u3002")}</p>
    <div class="card-stats"><div><strong>${activity.available_codes || 0}</strong><small>\u53EF\u7528\u53E3\u4EE4</small></div><div><strong>${activity.available_claims || 0}</strong><small>\u5269\u4F59\u673A\u4F1A</small></div></div>
    <div class="card-bottom"><span>${formatDate(activity.starts_at)}</span><span>${activity.ends_at ? `\u81F3 ${formatDate(activity.ends_at)}` : "\u957F\u671F\u6D3B\u52A8"}</span></div>
  </article>`;
  }
  async function openActivity(id) {
    $("#homeView").classList.add("hidden");
    $("#activityView").classList.remove("hidden");
    $("#activityContent").innerHTML = '<div class="loading-card">\u6B63\u5728\u8FDB\u5165\u53E3\u4EE4\u6C60\u2026</div>';
    history.replaceState(null, "", `#activity=${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    if (tier.min_value == null) return `\u2264 ${tier.max_value} ${unit}`;
    return `${tier.min_value}\u2013${tier.max_value} ${unit}`;
  }
  function renderActivity(activity, settings) {
    const active = activity.public_state === "active";
    const totalClaims = activity.tiers.reduce((sum, tier) => sum + Number(tier.available_claims || 0), 0);
    const scopeOptions = activity.scopes.map((scope) => `<option value="${scope.id}">${escapeHtml(scope.label)}</option>`).join("");
    const tiers = activity.tiers.map((tier) => `<article class="tier-card">
    <div><h3>${escapeHtml(tier.name)}</h3><p>${activity.reward_mode === "numeric" ? rewardRange(tier, activity.reward_unit) : `\u8BE5\u6863\u4F4D\u7531\u6D3B\u52A8\u7BA1\u7406\u5458\u914D\u7F6E`}</p>
      <div class="tier-metrics"><span><strong>${tier.available_codes}</strong> \u4E2A\u53E3\u4EE4</span><span><strong>${tier.available_claims}</strong> \u6B21\u673A\u4F1A</span><span>${tier.success_rate == null ? "\u53CD\u9988\u4E0D\u8DB3" : `\u6210\u529F\u7387 ${tier.success_rate}%`}</span></div>
    </div>
    <button class="primary-button claim-button" data-tier="${tier.id}" type="button" ${!active || tier.available_claims <= 0 ? "disabled" : ""}>${active ? tier.available_claims > 0 ? "\u590D\u5236\u4E00\u4E2A\u53E3\u4EE4" : "\u6682\u65F6\u9886\u5B8C" : statusLabel(activity.public_state)}</button>
  </article>`).join("");
    $("#activityContent").innerHTML = `
    <section class="activity-hero">
      <div class="activity-hero-row"><div><span class="status-badge status-${activity.public_state}">${statusLabel(activity.public_state)}</span><h1>${escapeHtml(activity.title)}</h1><p>${escapeHtml(activity.description || activity.summary)}</p>
        <div class="activity-meta"><span>\u5F00\u59CB ${formatDate(activity.starts_at)}</span><span>\u7ED3\u675F ${formatDate(activity.ends_at)}</span><span>\u6BCF\u4E2A\u53E3\u4EE4 ${activity.code_capacity} \u6B21</span><span>\u6BCF\u65E5\u53EF\u9886 ${activity.daily_claim_browser} \u4E2A</span></div>
      </div><div class="activity-summary-number"><strong>${totalClaims}</strong><small>\u9884\u8BA1\u5269\u4F59\u9886\u53D6\u673A\u4F1A</small></div></div>
    </section>
    <div class="pool-layout">
      <section class="panel"><div class="panel-head"><div><span class="eyebrow">\u81EA\u52A8\u5206\u914D</span><h2>\u9009\u62E9\u5956\u52B1\u6863\u4F4D</h2><p>\u7CFB\u7EDF\u4F18\u5148\u5206\u914D\u5269\u4F59\u6B21\u6570\u8F83\u5C11\u7684\u53E3\u4EE4\u3002</p></div></div>
        ${activity.scopes.length ? `<div class="scope-row"><label for="claimScope">\u9009\u62E9\u9002\u7528\u8303\u56F4</label><select id="claimScope"><option value="">\u8BF7\u9009\u62E9</option>${scopeOptions}</select></div>` : ""}
        <div class="tier-list">${tiers || '<div class="empty-state">\u7BA1\u7406\u5458\u5C1A\u672A\u914D\u7F6E\u5956\u52B1\u6863\u4F4D\u3002</div>'}</div>
        <label class="check-row"><input id="claimNotice" type="checkbox" ${localStorage.getItem("valley.claimNotice") ? "checked" : ""}><span>${escapeHtml(settings.claim_notice)}</span></label>
        <div class="info-strip">\u53EA\u6709\u526A\u8D34\u677F\u786E\u8BA4\u590D\u5236\u6210\u529F\u540E\u624D\u4F1A\u5360\u75281\u6B21\u3002\u540C\u4E00\u6D4F\u89C8\u5668\u518D\u6B21\u590D\u5236\u9886\u53D6\u8BB0\u5F55\u4E2D\u7684\u53E3\u4EE4\u4E0D\u4F1A\u91CD\u590D\u6263\u51CF\u3002</div>
      </section>
      <aside class="panel submit-panel"><div class="panel-head"><div><span class="eyebrow">\u8D21\u732E\u53E3\u4EE4</span><h2>\u5206\u4EAB\u4F60\u7684\u53E3\u4EE4</h2><p>\u65B0\u53E3\u4EE4\u4F1A\u5148\u8FDB\u5165\u5F85\u9A8C\u8BC1\u6C60\u3002</p></div></div>${active ? submitForm(activity, settings) : `<div class="empty-state">\u8FD9\u4E2A\u6D3B\u52A8\u5F53\u524D\u4E0D\u80FD\u63D0\u4EA4\u53E3\u4EE4\u3002</div>`}</aside>
    </div>`;
    $$(".claim-button").forEach((button) => button.addEventListener("click", () => claimCode(Number(button.dataset.tier), button)));
    $("#submitCodeForm")?.addEventListener("submit", submitCode);
    $("#claimNotice")?.addEventListener("change", (event) => {
      if (event.target.checked) localStorage.setItem("valley.claimNotice", "1");
      else localStorage.removeItem("valley.claimNotice");
    });
    state.formStartedAt = Date.now() / 1e3;
  }
  function submitForm(activity, settings) {
    let rewardField = "";
    if (activity.reward_mode === "numeric") {
      rewardField = `<div class="field"><label for="rewardValue">\u51C6\u786E\u5956\u52B1\u6570\u503C</label><input id="rewardValue" name="reward_value" type="number" min="0" step="any" required placeholder="\u4F8B\u5982 614"><small>\u7CFB\u7EDF\u4F1A\u81EA\u52A8\u5F52\u5165\u5BF9\u5E94\u6863\u4F4D</small></div>`;
    } else if (activity.reward_mode === "options") {
      rewardField = `<div class="field"><label for="rewardOption">\u5956\u52B1\u5185\u5BB9</label><select id="rewardOption" name="reward_option_id" required><option value="">\u8BF7\u9009\u62E9</option>${activity.reward_options.map((option) => `<option value="${option.id}">${escapeHtml(option.label)}</option>`).join("")}</select></div>`;
    }
    return `<form id="submitCodeForm">
    <div class="field"><label for="codeInput">\u53E3\u4EE4</label><input id="codeInput" name="code" maxlength="64" autocomplete="off" required placeholder="\u8F93\u5165\u5B8C\u6574\u53E3\u4EE4"></div>
    ${rewardField}
    ${activity.scopes.length ? `<div class="field"><label for="submitScope">\u9002\u7528\u8303\u56F4</label><select id="submitScope" name="scope_id" required><option value="">\u8BF7\u9009\u62E9</option>${activity.scopes.map((scope) => `<option value="${scope.id}">${escapeHtml(scope.label)}</option>`).join("")}</select></div>` : ""}
    <label class="honeypot" aria-hidden="true">\u7F51\u7AD9<input name="website" tabindex="-1" autocomplete="off"></label>
    <label class="check-row"><input name="terms_accepted" type="checkbox" ${localStorage.getItem("valley.terms") ? "checked" : ""} required><span>${escapeHtml(settings.terms)}</span></label>
    <button class="primary-button" type="submit">\u63D0\u4EA4\u5230\u4E92\u52A9\u6C60</button>
  </form>`;
  }
  async function claimCode(tierId, button) {
    const notice = $("#claimNotice");
    if (!notice?.checked) return toast("\u8BF7\u5148\u786E\u8BA4\u9886\u53D6\u63D0\u793A");
    const scope = $("#claimScope");
    if (scope && !scope.value) return toast("\u8BF7\u5148\u9009\u62E9\u9002\u7528\u8303\u56F4");
    button.disabled = true;
    button.textContent = "\u6B63\u5728\u5206\u914D\u2026";
    let reservation = null;
    try {
      reservation = await api(`/api/activities/${state.activity.id}/claim`, {
        method: "POST",
        body: JSON.stringify({ tier_id: tierId, scope_id: scope?.value || null, notice_accepted: true })
      });
      const copied = await copyText(reservation.code);
      if (!copied) throw new Error("\u6D4F\u89C8\u5668\u672A\u80FD\u590D\u5236\u53E3\u4EE4\uFF0C\u8BF7\u5141\u8BB8\u526A\u8D34\u677F\u6743\u9650\u540E\u91CD\u8BD5");
      await api(`/api/claims/${reservation.claim_id}/confirm`, { method: "POST", body: JSON.stringify({ claim_token: reservation.claim_token }) });
      saveClaim({ ...reservation, activity_id: state.activity.id, activity_title: state.activity.title, tier_id: tierId, created_at: (/* @__PURE__ */ new Date()).toISOString() });
      state.feedbackClaim = reservation;
      $("#copiedCode").textContent = reservation.code;
      $("#feedbackDialog").showModal();
      await refreshActivity();
    } catch (error) {
      if (reservation) {
        try {
          await api(`/api/claims/${reservation.claim_id}/cancel`, { method: "POST", body: JSON.stringify({ claim_token: reservation.claim_token }) });
        } catch (_) {
        }
      }
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "\u590D\u5236\u4E00\u4E2A\u53E3\u4EE4";
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
    button.textContent = "\u6B63\u5728\u63D0\u4EA4\u2026";
    try {
      const result = await api(`/api/activities/${state.activity.id}/codes`, { method: "POST", body: JSON.stringify(data) });
      const owners = JSON.parse(localStorage.getItem("valley.owners") || "[]");
      owners.unshift({ id: result.id, token: result.owner_token });
      localStorage.setItem("valley.owners", JSON.stringify(owners.slice(0, 100)));
      localStorage.setItem("valley.terms", "1");
      form.reset();
      form.elements.terms_accepted.checked = true;
      state.formStartedAt = Date.now() / 1e3;
      toast("\u63D0\u4EA4\u6210\u529F\uFF0C\u53E3\u4EE4\u5DF2\u8FDB\u5165\u5F85\u9A8C\u8BC1\u6C60");
      await refreshActivity();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "\u63D0\u4EA4\u5230\u4E92\u52A9\u6C60";
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
      await api(`/api/claims/${state.feedbackClaim.claim_id}/feedback`, { method: "POST", body: JSON.stringify({ claim_token: state.feedbackClaim.claim_token, feedback: type }) });
      const claims = JSON.parse(localStorage.getItem("valley.claims") || "[]");
      const record = claims.find((item) => item.claim_id === state.feedbackClaim.claim_id);
      if (record) record.feedback = type;
      localStorage.setItem("valley.claims", JSON.stringify(claims));
      $("#feedbackDialog").close();
      toast("\u611F\u8C22\u53CD\u9988\uFF0C\u5DF2\u66F4\u65B0\u53E3\u4EE4\u72B6\u6001");
      await refreshActivity();
    } catch (error) {
      toast(error.message);
    }
  }
  async function openHistory(tab = "claims") {
    $("#historyDialog").showModal();
    $$(".tab").forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
    const content = $("#historyContent");
    if (tab === "claims") {
      const claims = JSON.parse(localStorage.getItem("valley.claims") || "[]");
      content.innerHTML = claims.length ? `<div class="history-list">${claims.map((item) => `<article class="history-item"><div class="history-item-head"><strong>${escapeHtml(item.activity_title)}</strong><span class="history-meta">${formatDate(item.created_at)}</span></div><div class="history-code">${escapeHtml(item.code)}</div><div class="history-meta">${item.scope_label ? escapeHtml(item.scope_label) : "\u5168\u5E73\u53F0"} \xB7 ${item.feedback ? `\u5DF2\u53CD\u9988\uFF1A${feedbackLabel(item.feedback)}` : "\u5C1A\u672A\u53CD\u9988"}</div><div class="mini-actions"><button class="text-button copy-history" data-code="${escapeHtml(item.code)}" type="button">\u518D\u6B21\u590D\u5236</button>${!item.feedback ? `<button class="text-button history-feedback" data-id="${item.claim_id}" type="button">\u53CD\u9988\u7ED3\u679C</button>` : ""}</div></article>`).join("")}</div>` : '<div class="empty-state">\u5F53\u524D\u6D4F\u89C8\u5668\u8FD8\u6CA1\u6709\u9886\u53D6\u8BB0\u5F55\u3002</div>';
      $$(".copy-history", content).forEach((button) => button.addEventListener("click", async () => toast(await copyText(button.dataset.code) ? "\u5DF2\u518D\u6B21\u590D\u5236\uFF0C\u4E0D\u4F1A\u91CD\u590D\u6263\u6B21\u6570" : "\u590D\u5236\u5931\u8D25")));
      $$(".history-feedback", content).forEach((button) => button.addEventListener("click", () => {
        const claim = claims.find((item) => item.claim_id === Number(button.dataset.id));
        if (!claim) return;
        state.feedbackClaim = claim;
        $("#historyDialog").close();
        $("#copiedCode").textContent = claim.code;
        $("#feedbackDialog").showModal();
      }));
    } else {
      content.innerHTML = '<div class="loading-card">\u6B63\u5728\u8BFB\u53D6\u63D0\u4EA4\u8BB0\u5F55\u2026</div>';
      const owners = JSON.parse(localStorage.getItem("valley.owners") || "[]");
      try {
        const result = await api("/api/my/submissions", { method: "POST", body: JSON.stringify({ owner_tokens: owners.map((item) => item.token) }) });
        content.innerHTML = result.items.length ? `<div class="history-list">${result.items.map((item) => `<article class="history-item"><div class="history-item-head"><strong>${escapeHtml(item.activity_title)}</strong><span class="status-badge">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.tier_name || item.reward_label || "\u6D3B\u52A8\u5956\u52B1")} ${item.scope_label ? `\xB7 ${escapeHtml(item.scope_label)}` : ""}</p><div class="history-meta">\u5269\u4F59 ${item.remaining}/${item.capacity} \u6B21 \xB7 ${formatDate(item.created_at)}</div>${!["withdrawn", "expired"].includes(item.status) ? `<div class="mini-actions"><button class="text-button withdraw-code" data-id="${item.id}" type="button">\u64A4\u56DE\u53E3\u4EE4</button></div>` : ""}</article>`).join("")}</div>` : '<div class="empty-state">\u5F53\u524D\u6D4F\u89C8\u5668\u8FD8\u6CA1\u6709\u63D0\u4EA4\u8BB0\u5F55\u3002</div>';
        $$(".withdraw-code", content).forEach((button) => button.addEventListener("click", async () => {
          const owner = owners.find((item) => item.id === Number(button.dataset.id));
          if (!owner || !confirm("\u786E\u5B9A\u64A4\u56DE\u8FD9\u4E2A\u53E3\u4EE4\u5417\uFF1F\u64A4\u56DE\u540E\u4E0D\u4F1A\u518D\u6B21\u5206\u914D\u3002")) return;
          try {
            await api(`/api/codes/${owner.id}/withdraw`, { method: "POST", body: JSON.stringify({ owner_token: owner.token }) });
            toast("\u53E3\u4EE4\u5DF2\u64A4\u56DE");
            openHistory("submissions");
          } catch (error) {
            toast(error.message);
          }
        }));
      } catch (error) {
        content.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      }
    }
  }
  function feedbackLabel(value) {
    return { success: "\u5151\u6362\u6210\u529F", invalid: "\u65E0\u6548\u6216\u5DF2\u6EE1", mismatch: "\u5956\u52B1\u4E0D\u7B26" }[value] || value;
  }
  function showHome() {
    state.activity = null;
    history.replaceState(null, "", location.pathname);
    $("#activityView").classList.add("hidden");
    $("#homeView").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") $$("dialog[open]").forEach((dialog) => dialog.close());
    });
  });
})();
