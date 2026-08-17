(() => {
  // src/admin.ts
  var adminState = { dashboard: null, qrData: "" };
  var $ = (selector, root = document) => root.querySelector(selector);
  var $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...options.headers || {} } });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
    }
    if (!response.ok) {
      const error = new Error(payload.error || "\u8BF7\u6C42\u5931\u8D25");
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }
  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
  }
  function dateInput(value) {
    if (!value) return "";
    const d = new Date(value);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 6e4);
    return local.toISOString().slice(0, 16);
  }
  function statusLabel(status) {
    return { draft: "\u8349\u7A3F", published: "\u5DF2\u53D1\u5E03", paused: "\u5DF2\u6682\u505C", ended: "\u5DF2\u7ED3\u675F", pending: "\u5F85\u9A8C\u8BC1", verified: "\u5DF2\u9A8C\u8BC1", exhausted: "\u5DF2\u9886\u5B8C", withdrawn: "\u5DF2\u64A4\u56DE", expired: "\u5DF2\u8FC7\u671F" }[status] || status;
  }
  async function loadDashboard() {
    try {
      adminState.dashboard = await api("/api/admin/dashboard");
      $("#loginView").classList.add("hidden");
      $("#dashboardView").classList.remove("hidden");
      renderDashboard();
    } catch (error) {
      if (error.status === 401) {
        $("#dashboardView").classList.add("hidden");
        $("#loginView").classList.remove("hidden");
        return;
      }
      toast(error.message);
    }
  }
  function renderDashboard() {
    const { summary, activities, settings } = adminState.dashboard;
    $("#metrics").innerHTML = [
      [activities.length, "\u6D3B\u52A8\u603B\u6570"],
      [summary.total_codes || 0, "\u7D2F\u8BA1\u53E3\u4EE4"],
      [summary.active_codes || 0, "\u53EF\u7528\u53E3\u4EE4"],
      [summary.successes || 0, "\u6210\u529F\u53CD\u9988"]
    ].map(([value, label]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("");
    $("#activitiesPanel").innerHTML = `<div class="panel-toolbar"><div><h2>\u6D3B\u52A8\u7BA1\u7406</h2><p>\u8349\u7A3F\u4E0D\u4F1A\u51FA\u73B0\u5728\u7528\u6237\u7AEF\uFF1B\u53D1\u5E03\u540E\u5C06\u6309\u65F6\u95F4\u81EA\u52A8\u8FDB\u5165\u8FDB\u884C\u4E2D\u6216\u5373\u5C06\u5F00\u59CB\u3002</p></div></div>
    <div class="admin-activity-list">${activities.length ? activities.map(activityRow).join("") : '<div class="empty-state">\u8FD8\u6CA1\u6709\u6D3B\u52A8\u3002</div>'}</div>`;
    $$(".edit-activity").forEach((button) => button.addEventListener("click", () => openActivityEditor(Number(button.dataset.id))));
    populateActivityFilter(activities);
    fillSettings(settings);
  }
  function activityRow(activity) {
    return `<article class="admin-activity"><div><h3>${escapeHtml(activity.title)}</h3><p>${escapeHtml(activity.summary)}</p></div><div><strong>${statusLabel(activity.status)}</strong><small>\u5F53\u524D\u72B6\u6001</small></div><div><strong>${activity.tiers.length}</strong><small>\u5956\u52B1\u6863\u4F4D</small></div><div><strong>${activity.code_capacity}</strong><small>\u6BCF\u7801\u6B21\u6570</small></div><div class="admin-actions"><button class="small-button edit-activity" data-id="${activity.id}" type="button">\u7F16\u8F91\u914D\u7F6E</button></div></article>`;
  }
  function populateActivityFilter(activities) {
    const filter = $("#codeActivityFilter");
    const value = filter.value;
    filter.innerHTML = '<option value="">\u5168\u90E8\u6D3B\u52A8</option>' + activities.map((activity) => `<option value="${activity.id}">${escapeHtml(activity.title)}</option>`).join("");
    filter.value = value;
  }
  function fillSettings(settings) {
    const form = $("#settingsForm");
    for (const key of ["site_name", "site_notice", "terms", "claim_notice", "sponsor_title", "sponsor_text"]) form.elements[key].value = settings[key] || "";
    form.elements.sponsor_enabled.checked = Boolean(settings.sponsor_enabled);
    adminState.qrData = settings.sponsor_qr || "";
    const preview = $("#sponsorQrPreview");
    preview.classList.toggle("hidden", !adminState.qrData);
    if (adminState.qrData) preview.src = adminState.qrData;
  }
  function openActivityEditor(id = null) {
    const form = $("#activityForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.status.value = "draft";
    form.elements.reward_mode.value = "numeric";
    form.elements.reward_unit.value = "\u6D3B\u52A8\u4EE3\u5E01";
    form.elements.code_capacity.value = 10;
    form.elements.daily_claim_browser.value = 2;
    form.elements.daily_submit_browser.value = 3;
    form.elements.daily_submit_ip.value = 30;
    form.elements.tiers_text.value = "\u666E\u901A | 0 | 299\n\u8F83\u9AD8 | 300 | 599\n\u7A00\u6709 | 600 |";
    form.elements.scopes_text.value = "\u5FAE\u4FE1\u533A\nQQ\u533A";
    $("#activityDialogTitle").textContent = id ? "\u7F16\u8F91\u6D3B\u52A8" : "\u65B0\u5EFA\u6D3B\u52A8";
    if (id) {
      const activity = adminState.dashboard.activities.find((item) => item.id === id);
      if (!activity) return;
      for (const key of ["id", "title", "slug", "summary", "description", "status", "reward_mode", "reward_unit", "code_capacity", "daily_claim_browser", "daily_submit_browser", "daily_submit_ip"]) form.elements[key].value = activity[key] ?? "";
      form.elements.starts_at.value = dateInput(activity.starts_at);
      form.elements.ends_at.value = dateInput(activity.ends_at);
      form.elements.tiers_text.value = activity.tiers.map((tier) => `${tier.name} | ${tier.min_value ?? ""} | ${tier.max_value ?? ""}`).join("\n");
      form.elements.scopes_text.value = activity.scopes.map((scope) => scope.label).join("\n");
      const tierIndex = new Map(activity.tiers.map((tier, index) => [tier.id, index + 1]));
      form.elements.options_text.value = activity.reward_options.map((option) => `${option.label} | ${tierIndex.get(option.tier_id) || 1}`).join("\n");
    }
    toggleOptionConfig();
    $("#activityDialog").showModal();
  }
  function parseTiers(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const [name, min, max] = line.split("|").map((part) => part.trim());
      if (!name) throw new Error(`\u7B2C${index + 1}\u4E2A\u6863\u4F4D\u6CA1\u6709\u540D\u79F0`);
      return { name, min_value: min === "" || min == null ? null : Number(min), max_value: max === "" || max == null ? null : Number(max) };
    });
  }
  function parseOptions(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const [label, tier] = line.split("|").map((part) => part.trim());
      if (!label || !tier) throw new Error(`\u7B2C${index + 1}\u4E2A\u5956\u52B1\u9009\u9879\u683C\u5F0F\u4E0D\u5B8C\u6574`);
      return { label, tier_index: Number(tier) - 1 };
    });
  }
  async function saveActivity(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const id = data.id ? Number(data.id) : null;
    try {
      data.tiers = parseTiers(data.tiers_text);
      data.scopes = data.scopes_text.split(/\r?\n/).map((label) => label.trim()).filter(Boolean).map((label) => ({ label }));
      data.reward_options = data.reward_mode === "options" ? parseOptions(data.options_text) : [];
      for (const key of ["code_capacity", "daily_claim_browser", "daily_submit_browser", "daily_submit_ip"]) data[key] = Number(data[key]);
      data.starts_at = data.starts_at ? new Date(data.starts_at).toISOString() : null;
      data.ends_at = data.ends_at ? new Date(data.ends_at).toISOString() : null;
      const path = id ? `/api/admin/activities/${id}` : "/api/admin/activities";
      await api(path, { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
      $("#activityDialog").close();
      toast("\u6D3B\u52A8\u914D\u7F6E\u5DF2\u4FDD\u5B58");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  }
  function toggleOptionConfig() {
    const enabled = $("#activityForm").elements.reward_mode.value === "options";
    $(".option-config").classList.toggle("disabled-config", !enabled);
  }
  async function loadCodes() {
    const activityId = $("#codeActivityFilter").value;
    $("#codesTable").innerHTML = '<tr><td colspan="6">\u6B63\u5728\u8BFB\u53D6\u2026</td></tr>';
    try {
      const result = await api(`/api/admin/codes${activityId ? `?activity_id=${activityId}` : ""}`);
      $("#codesTable").innerHTML = result.items.length ? result.items.map(codeRow).join("") : '<tr><td colspan="6">\u6682\u65E0\u53E3\u4EE4</td></tr>';
      $$(".code-status-action").forEach((button) => button.addEventListener("click", () => changeCodeStatus(Number(button.dataset.id), button.dataset.status)));
    } catch (error) {
      toast(error.message);
    }
  }
  function codeRow(code) {
    const active = ["pending", "verified", "exhausted"].includes(code.status);
    return `<tr><td><strong>${escapeHtml(code.activity_title)}</strong><div class="table-meta">${escapeHtml(code.tier_name || code.reward_label || "\u6D3B\u52A8\u5956\u52B1")} ${code.scope_label ? `\xB7 ${escapeHtml(code.scope_label)}` : ""}</div></td><td class="code-cell">${escapeHtml(code.code_value || "\u5DF2\u6E05\u9664")}</td><td><span class="status-chip ${code.status}">${statusLabel(code.status)}</span></td><td>${code.remaining}/${code.capacity}</td><td class="table-meta">\u6210\u529F ${code.success_reports}<br>\u5931\u6548 ${code.failure_reports} \xB7 \u4E0D\u7B26 ${code.mismatch_reports}</td><td>${active ? `<button class="small-button danger code-status-action" data-id="${code.id}" data-status="paused">\u6682\u505C</button>` : `<button class="small-button code-status-action" data-id="${code.id}" data-status="pending">\u6062\u590D</button>`}</td></tr>`;
  }
  async function changeCodeStatus(id, status) {
    try {
      await api(`/api/admin/codes/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      toast("\u53E3\u4EE4\u72B6\u6001\u5DF2\u66F4\u65B0");
      loadCodes();
    } catch (error) {
      toast(error.message);
    }
  }
  async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    data.sponsor_enabled = form.elements.sponsor_enabled.checked;
    data.sponsor_qr = adminState.qrData;
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(data) });
      toast("\u7F51\u7AD9\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  }
  function readQr(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 75e4) return toast("\u4E8C\u7EF4\u7801\u56FE\u7247\u5EFA\u8BAE\u5C0F\u4E8E750KB");
    const reader = new FileReader();
    reader.onload = () => {
      adminState.qrData = reader.result;
      const preview = $("#sponsorQrPreview");
      preview.src = reader.result;
      preview.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  }
  document.addEventListener("DOMContentLoaded", async () => {
    $("#loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("button", event.currentTarget);
      button.disabled = true;
      try {
        await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: event.currentTarget.elements.password.value }) });
        event.currentTarget.reset();
        await loadDashboard();
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    });
    $("#logoutButton").addEventListener("click", async () => {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      location.reload();
    });
    $("#newActivityButton").addEventListener("click", () => openActivityEditor());
    $("#activityForm").addEventListener("submit", saveActivity);
    $("#activityForm").elements.reward_mode.addEventListener("change", toggleOptionConfig);
    $("#codeActivityFilter").addEventListener("change", loadCodes);
    $("#settingsForm").addEventListener("submit", saveSettings);
    $("#sponsorQrFile").addEventListener("change", readQr);
    $$(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
    $$(".admin-tab").forEach((button) => button.addEventListener("click", () => {
      $$(".admin-tab").forEach((node) => node.classList.toggle("active", node === button));
      for (const key of ["activities", "codes", "settings"]) $(`#${key}Panel`).classList.toggle("hidden", key !== button.dataset.panel);
      if (button.dataset.panel === "codes") loadCodes();
    }));
    await loadDashboard();
  });
})();
