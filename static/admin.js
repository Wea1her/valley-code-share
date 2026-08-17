const adminState = { dashboard: null, qrData: "" };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {credentials:"same-origin", ...options, headers:{"Content-Type":"application/json", ...(options.headers || {})}});
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* empty */ }
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }
function toast(message) { const node=$("#toast"); node.textContent=message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer=setTimeout(()=>node.classList.remove("show"),2600); }
function dateInput(value) { if (!value) return ""; const d=new Date(value); const local=new Date(d.getTime()-d.getTimezoneOffset()*60000); return local.toISOString().slice(0,16); }
function statusLabel(status) { return ({draft:"草稿",published:"已发布",paused:"已暂停",ended:"已结束",pending:"待验证",verified:"已验证",exhausted:"已领完",withdrawn:"已撤回",expired:"已过期"})[status] || status; }

async function loadDashboard() {
  try {
    adminState.dashboard = await api("/api/admin/dashboard");
    $("#loginView").classList.add("hidden");
    $("#dashboardView").classList.remove("hidden");
    renderDashboard();
  } catch (error) {
    if (error.status === 401) { $("#dashboardView").classList.add("hidden"); $("#loginView").classList.remove("hidden"); return; }
    toast(error.message);
  }
}

function renderDashboard() {
  const {summary, activities, settings} = adminState.dashboard;
  $("#metrics").innerHTML = [
    [activities.length,"活动总数"], [summary.total_codes || 0,"累计口令"], [summary.active_codes || 0,"可用口令"], [summary.successes || 0,"成功反馈"]
  ].map(([value,label]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("");
  $("#activitiesPanel").innerHTML = `<div class="panel-toolbar"><div><h2>活动管理</h2><p>草稿不会出现在用户端；发布后将按时间自动进入进行中或即将开始。</p></div></div>
    <div class="admin-activity-list">${activities.length ? activities.map(activityRow).join("") : '<div class="empty-state">还没有活动。</div>'}</div>`;
  $$(".edit-activity").forEach((button) => button.addEventListener("click", () => openActivityEditor(Number(button.dataset.id))));
  populateActivityFilter(activities);
  fillSettings(settings);
}

function activityRow(activity) {
  return `<article class="admin-activity"><div><h3>${escapeHtml(activity.title)}</h3><p>${escapeHtml(activity.summary)}</p></div><div><strong>${statusLabel(activity.status)}</strong><small>当前状态</small></div><div><strong>${activity.tiers.length}</strong><small>奖励档位</small></div><div><strong>${activity.code_capacity}</strong><small>每码次数</small></div><div class="admin-actions"><button class="small-button edit-activity" data-id="${activity.id}" type="button">编辑配置</button></div></article>`;
}

function populateActivityFilter(activities) {
  const filter=$("#codeActivityFilter");
  const value=filter.value;
  filter.innerHTML='<option value="">全部活动</option>'+activities.map((activity)=>`<option value="${activity.id}">${escapeHtml(activity.title)}</option>`).join("");
  filter.value=value;
}

function fillSettings(settings) {
  const form=$("#settingsForm");
  for (const key of ["site_name","site_notice","terms","claim_notice","sponsor_title","sponsor_text"]) form.elements[key].value=settings[key] || "";
  form.elements.sponsor_enabled.checked=Boolean(settings.sponsor_enabled);
  adminState.qrData=settings.sponsor_qr || "";
  const preview=$("#sponsorQrPreview");
  preview.classList.toggle("hidden", !adminState.qrData);
  if (adminState.qrData) preview.src=adminState.qrData;
}

function openActivityEditor(id = null) {
  const form=$("#activityForm");
  form.reset();
  form.elements.id.value="";
  form.elements.status.value="draft";
  form.elements.reward_mode.value="numeric";
  form.elements.reward_unit.value="活动代币";
  form.elements.code_capacity.value=10;
  form.elements.daily_claim_browser.value=2;
  form.elements.daily_submit_browser.value=3;
  form.elements.daily_submit_ip.value=30;
  form.elements.tiers_text.value="普通 | 0 | 299\n较高 | 300 | 599\n稀有 | 600 |";
  form.elements.scopes_text.value="微信区\nQQ区";
  $("#activityDialogTitle").textContent=id ? "编辑活动" : "新建活动";
  if (id) {
    const activity=adminState.dashboard.activities.find((item)=>item.id===id);
    if (!activity) return;
    for (const key of ["id","title","slug","summary","description","status","reward_mode","reward_unit","code_capacity","daily_claim_browser","daily_submit_browser","daily_submit_ip"]) form.elements[key].value=activity[key] ?? "";
    form.elements.starts_at.value=dateInput(activity.starts_at);
    form.elements.ends_at.value=dateInput(activity.ends_at);
    form.elements.tiers_text.value=activity.tiers.map((tier)=>`${tier.name} | ${tier.min_value ?? ""} | ${tier.max_value ?? ""}`).join("\n");
    form.elements.scopes_text.value=activity.scopes.map((scope)=>scope.label).join("\n");
    const tierIndex=new Map(activity.tiers.map((tier,index)=>[tier.id,index+1]));
    form.elements.options_text.value=activity.reward_options.map((option)=>`${option.label} | ${tierIndex.get(option.tier_id) || 1}`).join("\n");
  }
  toggleOptionConfig();
  $("#activityDialog").showModal();
}

function parseTiers(text) {
  return text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean).map((line,index)=>{
    const [name,min,max]=line.split("|").map((part)=>part.trim());
    if (!name) throw new Error(`第${index+1}个档位没有名称`);
    return {name, min_value:min===""||min==null?null:Number(min), max_value:max===""||max==null?null:Number(max)};
  });
}
function parseOptions(text) {
  return text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean).map((line,index)=>{
    const [label,tier]=line.split("|").map((part)=>part.trim());
    if (!label || !tier) throw new Error(`第${index+1}个奖励选项格式不完整`);
    return {label, tier_index:Number(tier)-1};
  });
}

async function saveActivity(event) {
  event.preventDefault();
  const form=event.currentTarget;
  const data=Object.fromEntries(new FormData(form).entries());
  const id=data.id ? Number(data.id) : null;
  try {
    data.tiers=parseTiers(data.tiers_text);
    data.scopes=data.scopes_text.split(/\r?\n/).map((label)=>label.trim()).filter(Boolean).map((label)=>({label}));
    data.reward_options=data.reward_mode==="options" ? parseOptions(data.options_text) : [];
    for (const key of ["code_capacity","daily_claim_browser","daily_submit_browser","daily_submit_ip"]) data[key]=Number(data[key]);
    data.starts_at=data.starts_at ? new Date(data.starts_at).toISOString() : null;
    data.ends_at=data.ends_at ? new Date(data.ends_at).toISOString() : null;
    const path=id ? `/api/admin/activities/${id}` : "/api/admin/activities";
    await api(path,{method:id?"PUT":"POST",body:JSON.stringify(data)});
    $("#activityDialog").close();
    toast("活动配置已保存");
    await loadDashboard();
  } catch (error) { toast(error.message); }
}

function toggleOptionConfig() {
  const enabled=$("#activityForm").elements.reward_mode.value==="options";
  $(".option-config").classList.toggle("disabled-config", !enabled);
}

async function loadCodes() {
  const activityId=$("#codeActivityFilter").value;
  $("#codesTable").innerHTML='<tr><td colspan="6">正在读取…</td></tr>';
  try {
    const result=await api(`/api/admin/codes${activityId?`?activity_id=${activityId}`:""}`);
    $("#codesTable").innerHTML=result.items.length ? result.items.map(codeRow).join("") : '<tr><td colspan="6">暂无口令</td></tr>';
    $$(".code-status-action").forEach((button)=>button.addEventListener("click",()=>changeCodeStatus(Number(button.dataset.id),button.dataset.status)));
  } catch (error) { toast(error.message); }
}

function codeRow(code) {
  const active=["pending","verified","exhausted"].includes(code.status);
  return `<tr><td><strong>${escapeHtml(code.activity_title)}</strong><div class="table-meta">${escapeHtml(code.tier_name || code.reward_label || "活动奖励")} ${code.scope_label?`· ${escapeHtml(code.scope_label)}`:""}</div></td><td class="code-cell">${escapeHtml(code.code_value || "已清除")}</td><td><span class="status-chip ${code.status}">${statusLabel(code.status)}</span></td><td>${code.remaining}/${code.capacity}</td><td class="table-meta">成功 ${code.success_reports}<br>失效 ${code.failure_reports} · 不符 ${code.mismatch_reports}</td><td>${active?`<button class="small-button danger code-status-action" data-id="${code.id}" data-status="paused">暂停</button>`:`<button class="small-button code-status-action" data-id="${code.id}" data-status="pending">恢复</button>`}</td></tr>`;
}

async function changeCodeStatus(id,status) {
  try { await api(`/api/admin/codes/${id}/status`,{method:"POST",body:JSON.stringify({status})}); toast("口令状态已更新"); loadCodes(); } catch (error) { toast(error.message); }
}

async function saveSettings(event) {
  event.preventDefault();
  const form=event.currentTarget;
  const data=Object.fromEntries(new FormData(form).entries());
  data.sponsor_enabled=form.elements.sponsor_enabled.checked;
  data.sponsor_qr=adminState.qrData;
  try { await api("/api/admin/settings",{method:"PUT",body:JSON.stringify(data)}); toast("网站设置已保存"); await loadDashboard(); } catch (error) { toast(error.message); }
}

function readQr(event) {
  const file=event.target.files[0];
  if (!file) return;
  if (file.size>750000) return toast("二维码图片建议小于750KB");
  const reader=new FileReader();
  reader.onload=()=>{adminState.qrData=reader.result; const preview=$("#sponsorQrPreview"); preview.src=reader.result; preview.classList.remove("hidden");};
  reader.readAsDataURL(file);
}

document.addEventListener("DOMContentLoaded", async()=>{
  $("#loginForm").addEventListener("submit",async(event)=>{event.preventDefault(); const button=$("button",event.currentTarget); button.disabled=true; try {await api("/api/admin/login",{method:"POST",body:JSON.stringify({password:event.currentTarget.elements.password.value})}); event.currentTarget.reset(); await loadDashboard();} catch(error){toast(error.message);} finally{button.disabled=false;}});
  $("#logoutButton").addEventListener("click",async()=>{await api("/api/admin/logout",{method:"POST",body:"{}"}); location.reload();});
  $("#newActivityButton").addEventListener("click",()=>openActivityEditor());
  $("#activityForm").addEventListener("submit",saveActivity);
  $("#activityForm").elements.reward_mode.addEventListener("change",toggleOptionConfig);
  $("#codeActivityFilter").addEventListener("change",loadCodes);
  $("#settingsForm").addEventListener("submit",saveSettings);
  $("#sponsorQrFile").addEventListener("change",readQr);
  $$(".close-dialog").forEach((button)=>button.addEventListener("click",()=>button.closest("dialog").close()));
  $$(".admin-tab").forEach((button)=>button.addEventListener("click",()=>{ $$(".admin-tab").forEach((node)=>node.classList.toggle("active",node===button)); for(const key of ["activities","codes","settings"]) $(`#${key}Panel`).classList.toggle("hidden",key!==button.dataset.panel); if(button.dataset.panel==="codes") loadCodes(); }));
  await loadDashboard();
});
