import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AppError,
  cleanup,
  dayStartShanghai,
  db,
  ensureSchema,
  hashValue,
  normalizeCode,
  publicSettings,
  token
} from "../server/database.js";

const CODE_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const VISITOR_PATTERN = /^[A-Za-z0-9-]{16,80}$/;

type Json = Record<string, any>;
type VercelRequest = IncomingMessage & {
  body?: any;
  query: Record<string, string | string[] | undefined>;
  socket: IncomingMessage["socket"];
};
type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(value: unknown): VercelResponse;
};

function send(res: VercelResponse, status: number, value: unknown, cookie?: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (cookie) res.setHeader("Set-Cookie", cookie);
  return res.status(status).json(value);
}

function requestBody(req: VercelRequest): Json {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { throw new AppError(400, "请求内容不是有效JSON"); }
  }
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString("utf8")); } catch { throw new AppError(400, "请求内容不是有效JSON"); }
  }
  if (typeof req.body !== "object" || Array.isArray(req.body)) throw new AppError(400, "请求内容无效");
  return req.body;
}

function routePath(req: VercelRequest) {
  const path = req.query.path;
  if (Array.isArray(path)) return `/${path.join("/")}`;
  if (path) return `/${path}`;
  const url = new URL(req.url || "/api/index", "https://local.invalid");
  return url.pathname.replace(/^\/api\/?/, "/").replace(/^\/index\/?/, "/");
}

function parseCookies(req: VercelRequest) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
  }));
}

async function identity(req: VercelRequest) {
  const visitorId = String(req.headers["x-visitor-id"] || "");
  if (!VISITOR_PATTERN.test(visitorId)) throw new AppError(400, "浏览器标识无效，请刷新页面后重试", "invalid_visitor");
  const forwarded = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  return {
    visitorHash: await hashValue(`visitor:${visitorId}`),
    ipHash: await hashValue(`ip:${forwarded}`)
  };
}

function publicState(activity: Json) {
  if (activity.status !== "published") return activity.status;
  const now = Date.now();
  if (activity.starts_at && now < new Date(activity.starts_at).getTime()) return "upcoming";
  if (activity.ends_at && now >= new Date(activity.ends_at).getTime()) return "ended";
  return "active";
}

async function activityPayload(activity: Json, includeConfig = true, sql = db()) {
  const payload: Json = { ...activity, public_state: publicState(activity) };
  if (!includeConfig) return payload;
  payload.tiers = await sql`SELECT id,name,min_value,max_value,sort_order FROM tiers WHERE activity_id=${activity.id} ORDER BY sort_order,id`;
  payload.reward_options = await sql`SELECT id,tier_id,label,sort_order FROM reward_options WHERE activity_id=${activity.id} ORDER BY sort_order,id`;
  payload.scopes = await sql`SELECT id,label,sort_order FROM scopes WHERE activity_id=${activity.id} ORDER BY sort_order,id`;
  return payload;
}

async function activeActivity(activityId: number, sql = db()) {
  const rows = await sql`SELECT * FROM activities WHERE id=${activityId}`;
  if (!rows.length) throw new AppError(404, "没有找到这个活动");
  const state = publicState(rows[0]);
  if (state !== "active") {
    const messages: Json = { upcoming: "活动尚未开始", paused: "活动暂时停止", ended: "活动已经结束", draft: "活动尚未发布" };
    throw new AppError(409, messages[state] || "活动当前不可操作", "activity_unavailable");
  }
  return rows[0];
}

async function bootstrap() {
  const sql = db();
  await cleanup(sql);
  const rows = await sql`SELECT * FROM activities WHERE status IN ('published','paused','ended') ORDER BY starts_at DESC,id DESC`;
  const activities = [];
  for (const row of rows) {
    const payload = await activityPayload(row, false, sql);
    const [stats] = await sql`SELECT COUNT(*)::int AS codes,COALESCE(SUM(remaining),0)::int AS claims FROM codes
      WHERE activity_id=${row.id} AND status IN ('pending','verified') AND remaining>0`;
    activities.push({ ...payload, available_codes: stats.codes, available_claims: stats.claims });
  }
  return { settings: await publicSettings(sql), activities };
}

async function getPublicActivity(activityId: number) {
  const sql = db();
  await cleanup(sql);
  const rows = await sql`SELECT * FROM activities WHERE id=${activityId} AND status IN ('published','paused','ended')`;
  if (!rows.length) throw new AppError(404, "没有找到这个活动");
  const payload = await activityPayload(rows[0], true, sql);
  for (const tier of payload.tiers) {
    const [stats] = await sql`SELECT COUNT(*)::int AS codes,COALESCE(SUM(remaining),0)::int AS claims,
      COALESCE(SUM(success_reports),0)::int AS successes,
      COALESCE(SUM(failure_reports+mismatch_reports),0)::int AS failures,
      MAX(last_success_at) AS last_success_at
      FROM codes WHERE activity_id=${activityId} AND tier_id=${tier.id}
        AND status IN ('pending','verified') AND remaining>0`;
    tier.available_codes = stats.codes;
    tier.available_claims = stats.claims;
    tier.success_rate = stats.successes + stats.failures >= 3 ? Math.round(stats.successes * 100 / (stats.successes + stats.failures)) : null;
    tier.last_success_at = stats.last_success_at;
  }
  return { activity: payload, settings: await publicSettings(sql) };
}

async function resolveReward(sql: any, activity: Json, data: Json) {
  if (activity.reward_mode === "numeric") {
    const rewardValue = Number(data.reward_value);
    if (!Number.isFinite(rewardValue)) throw new AppError(400, "请填写正确的奖励数值");
    const tiers = await sql`SELECT id FROM tiers WHERE activity_id=${activity.id}
      AND (min_value IS NULL OR min_value<=${rewardValue}) AND (max_value IS NULL OR max_value>=${rewardValue})
      ORDER BY sort_order,id LIMIT 1`;
    if (!tiers.length) throw new AppError(400, "奖励数值不在管理员配置的档位范围内");
    return { tierId: tiers[0].id, rewardValue, optionId: null };
  }
  if (activity.reward_mode === "options") {
    const optionId = Number(data.reward_option_id);
    if (!Number.isInteger(optionId)) throw new AppError(400, "请选择奖励选项");
    const options = await sql`SELECT id,tier_id FROM reward_options WHERE id=${optionId} AND activity_id=${activity.id}`;
    if (!options.length) throw new AppError(400, "奖励选项无效");
    return { tierId: options[0].tier_id, rewardValue: null, optionId };
  }
  const tiers = await sql`SELECT id FROM tiers WHERE activity_id=${activity.id} ORDER BY sort_order,id LIMIT 1`;
  return { tierId: tiers[0]?.id || null, rewardValue: null, optionId: null };
}

async function resolveScope(sql: any, activityId: number, rawScope: any) {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM scopes WHERE activity_id=${activityId}`;
  if (!count) return null;
  const scopeId = Number(rawScope);
  if (!Number.isInteger(scopeId)) throw new AppError(400, "请选择口令适用范围");
  const rows = await sql`SELECT id FROM scopes WHERE id=${scopeId} AND activity_id=${activityId}`;
  if (!rows.length) throw new AppError(400, "适用范围无效");
  return scopeId;
}

async function submitCode(activityId: number, data: Json, who: Json) {
  const code = normalizeCode(data.code);
  if (!CODE_PATTERN.test(code)) throw new AppError(400, "口令需为4到64位字母、数字、短横线或下划线");
  if (data.website) throw new AppError(400, "提交未通过验证");
  if (data.form_started_at && Date.now() / 1000 - Number(data.form_started_at) < 1.2) throw new AppError(429, "提交过快，请稍后重试");
  if (!data.terms_accepted) throw new AppError(400, "请先确认互助规则");
  const ownerToken = token();
  const sql = db();
  try {
    return await sql.begin(async (tx) => {
      const activity = await activeActivity(activityId, tx);
      const dayStart = dayStartShanghai();
      const [browser] = await tx`SELECT COUNT(*)::int AS count FROM codes WHERE activity_id=${activityId}
        AND submitter_visitor_hash=${who.visitorHash} AND created_at>=${dayStart}`;
      const [ip] = await tx`SELECT COUNT(*)::int AS count FROM codes WHERE activity_id=${activityId}
        AND submitter_ip_hash=${who.ipHash} AND created_at>=${dayStart}`;
      if (browser.count >= activity.daily_submit_browser) throw new AppError(429, "你今天在这个活动中提交的口令已达上限", "submit_limit");
      if (ip.count >= activity.daily_submit_ip) throw new AppError(429, "当前网络今天提交过于频繁，请明天再试", "ip_submit_limit");
      const reward = await resolveReward(tx, activity, data);
      const scopeId = await resolveScope(tx, activityId, data.scope_id);
      const [created] = await tx`INSERT INTO codes ${tx({
        activity_id: activityId,
        code_value: code,
        code_hash: await hashValue(`code:${activityId}:${code}`, tx),
        reward_value: reward.rewardValue,
        reward_option_id: reward.optionId,
        tier_id: reward.tierId,
        scope_id: scopeId,
        remaining: activity.code_capacity,
        capacity: activity.code_capacity,
        status: "pending",
        owner_token_hash: await hashValue(`owner:${ownerToken}`, tx),
        submitter_visitor_hash: who.visitorHash,
        submitter_ip_hash: who.ipHash
      })} RETURNING id,remaining`;
      return { id: created.id, owner_token: ownerToken, remaining: created.remaining };
    });
  } catch (error: any) {
    if (error.code === "23505") throw new AppError(409, "这个口令已经提交过了", "duplicate_code");
    throw error;
  }
}

async function reserveClaim(activityId: number, data: Json, who: Json) {
  if (!data.notice_accepted) throw new AppError(400, "请先确认领取提示");
  const tierId = Number(data.tier_id);
  if (!Number.isInteger(tierId)) throw new AppError(400, "请选择奖励档位");
  const claimToken = token();
  const sql = db();
  return sql.begin(async (tx) => {
    const activity = await activeActivity(activityId, tx);
    const tiers = await tx`SELECT id FROM tiers WHERE id=${tierId} AND activity_id=${activityId}`;
    if (!tiers.length) throw new AppError(400, "奖励档位无效");
    const scopeId = await resolveScope(tx, activityId, data.scope_id);
    const [used] = await tx`SELECT COUNT(*)::int AS count FROM claims q JOIN codes c ON c.id=q.code_id
      WHERE c.activity_id=${activityId} AND q.visitor_hash=${who.visitorHash}
        AND q.state IN ('reserved','confirmed') AND q.reserved_at>=${dayStartShanghai()}`;
    if (used.count >= activity.daily_claim_browser) throw new AppError(429, "你今天在这个活动中的领取次数已达上限", "claim_limit");
    const candidates = scopeId == null
      ? await tx`SELECT c.* FROM codes c WHERE c.activity_id=${activityId} AND c.tier_id=${tierId}
          AND c.status IN ('pending','verified') AND c.remaining>0 AND c.scope_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM claims q WHERE q.code_id=c.id AND q.visitor_hash=${who.visitorHash})
          ORDER BY c.remaining ASC,RANDOM() LIMIT 1 FOR UPDATE SKIP LOCKED`
      : await tx`SELECT c.* FROM codes c WHERE c.activity_id=${activityId} AND c.tier_id=${tierId}
          AND c.status IN ('pending','verified') AND c.remaining>0 AND c.scope_id=${scopeId}
          AND NOT EXISTS(SELECT 1 FROM claims q WHERE q.code_id=c.id AND q.visitor_hash=${who.visitorHash})
          ORDER BY c.remaining ASC,RANDOM() LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!candidates.length) throw new AppError(404, "这个档位暂时没有可领取的口令", "pool_empty");
    const candidate = candidates[0];
    const remaining = candidate.remaining - 1;
    await tx`UPDATE codes SET remaining=${remaining},status=${remaining === 0 ? "exhausted" : candidate.status},updated_at=NOW() WHERE id=${candidate.id}`;
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    const [claim] = await tx`INSERT INTO claims ${tx({
      code_id: candidate.id,
      visitor_hash: who.visitorHash,
      ip_hash: who.ipHash,
      claim_token_hash: await hashValue(`claim:${claimToken}`, tx),
      state: "reserved",
      expires_at: expiresAt
    })} RETURNING id`;
    const option = candidate.reward_option_id ? (await tx`SELECT label FROM reward_options WHERE id=${candidate.reward_option_id}`)[0] : null;
    const scope = candidate.scope_id ? (await tx`SELECT label FROM scopes WHERE id=${candidate.scope_id}`)[0] : null;
    return {
      claim_id: claim.id,
      claim_token: claimToken,
      code: candidate.code_value,
      reward_value: candidate.reward_value,
      reward_label: option?.label || null,
      scope_label: scope?.label || null,
      expires_at: expiresAt
    };
  });
}

async function claimByToken(sql: any, claimId: number, claimToken: string) {
  const rows = await sql`SELECT * FROM claims WHERE id=${claimId} AND claim_token_hash=${await hashValue(`claim:${claimToken}`, sql)}`;
  if (!rows.length) throw new AppError(404, "领取记录不存在");
  return rows[0];
}

async function confirmClaim(claimId: number, claimToken: string) {
  const sql = db();
  return sql.begin(async (tx) => {
    const claim = await claimByToken(tx, claimId, claimToken);
    if (claim.state === "confirmed") return { confirmed: true };
    if (claim.state !== "reserved" || new Date(claim.expires_at).getTime() < Date.now()) throw new AppError(409, "这个口令预留已经失效，请重新领取");
    await tx`UPDATE claims SET state='confirmed',confirmed_at=NOW() WHERE id=${claimId}`;
    return { confirmed: true };
  });
}

async function cancelClaim(claimId: number, claimToken: string) {
  const sql = db();
  return sql.begin(async (tx) => {
    const claim = await claimByToken(tx, claimId, claimToken);
    if (claim.state !== "reserved") return { released: ["cancelled","released"].includes(claim.state) };
    await tx`UPDATE claims SET state='cancelled' WHERE id=${claimId}`;
    await tx`UPDATE codes SET remaining=LEAST(capacity,remaining+1),
      status=CASE WHEN status='exhausted' THEN 'pending' ELSE status END,updated_at=NOW()
      WHERE id=${claim.code_id} AND status IN ('pending','verified','exhausted')`;
    return { released: true };
  });
}

async function saveFeedback(claimId: number, claimToken: string, feedback: string) {
  if (!["success","invalid","mismatch"].includes(feedback)) throw new AppError(400, "反馈类型无效");
  const sql = db();
  return sql.begin(async (tx) => {
    const claim = await claimByToken(tx, claimId, claimToken);
    if (claim.state !== "confirmed") throw new AppError(409, "只有复制成功的口令才能反馈");
    if (claim.feedback) throw new AppError(409, "你已经反馈过这个口令");
    await tx`UPDATE claims SET feedback=${feedback},feedback_at=NOW() WHERE id=${claimId}`;
    if (feedback === "success") {
      await tx`UPDATE codes SET success_reports=success_reports+1,
        status=CASE WHEN status='pending' THEN 'verified' ELSE status END,last_success_at=NOW(),updated_at=NOW()
        WHERE id=${claim.code_id}`;
    } else if (feedback === "invalid") {
      await tx`UPDATE codes SET failure_reports=failure_reports+1,updated_at=NOW() WHERE id=${claim.code_id}`;
    } else {
      await tx`UPDATE codes SET mismatch_reports=mismatch_reports+1,updated_at=NOW() WHERE id=${claim.code_id}`;
    }
    if (feedback !== "success") {
      const [reports] = await tx`SELECT COUNT(DISTINCT visitor_hash)::int AS visitors,COUNT(DISTINCT ip_hash)::int AS ips
        FROM claims WHERE code_id=${claim.code_id} AND feedback=${feedback}`;
      if (reports.visitors >= 2 && reports.ips >= 2) {
        await tx`UPDATE codes SET status='paused',updated_at=NOW() WHERE id=${claim.code_id} AND status IN ('pending','verified','exhausted')`;
      }
    }
    const [code] = await tx`SELECT status FROM codes WHERE id=${claim.code_id}`;
    return { saved: true, code_status: code.status };
  });
}

async function mySubmissions(ownerTokens: string[]) {
  if (!ownerTokens?.length) return [];
  const sql = db();
  const hashes = await Promise.all(ownerTokens.slice(0, 100).map((value) => hashValue(`owner:${value}`, sql)));
  return sql`SELECT c.id,c.activity_id,c.reward_value,c.remaining,c.capacity,c.status,c.created_at,
    a.title AS activity_title,t.name AS tier_name,s.label AS scope_label,o.label AS reward_label
    FROM codes c JOIN activities a ON a.id=c.activity_id
    LEFT JOIN tiers t ON t.id=c.tier_id LEFT JOIN scopes s ON s.id=c.scope_id
    LEFT JOIN reward_options o ON o.id=c.reward_option_id
    WHERE c.owner_token_hash IN ${sql(hashes)} ORDER BY c.created_at DESC`;
}

async function withdrawCode(codeId: number, ownerToken: string) {
  const sql = db();
  const rows = await sql`SELECT id,status FROM codes WHERE id=${codeId} AND owner_token_hash=${await hashValue(`owner:${ownerToken}`, sql)}`;
  if (!rows.length) throw new AppError(404, "没有找到可撤回的口令");
  if (!["withdrawn","expired"].includes(rows[0].status)) await sql`UPDATE codes SET status='withdrawn',updated_at=NOW() WHERE id=${codeId}`;
  return { withdrawn: true };
}

async function adminLogin(password: string) {
  if (!process.env.ADMIN_PASSWORD) throw new AppError(503, "生产环境尚未配置ADMIN_PASSWORD", "admin_password_not_configured");
  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  const actual = Buffer.from(password || "");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new AppError(401, "管理员密码不正确");
  const sessionToken = token();
  const sql = db();
  await sql`INSERT INTO admin_sessions (token_hash,expires_at) VALUES (${await hashValue(`admin:${sessionToken}`, sql)},NOW()+INTERVAL '12 hours')`;
  return sessionToken;
}

async function requireAdmin(req: VercelRequest) {
  const sessionToken = parseCookies(req).admin_session;
  if (!sessionToken) throw new AppError(401, "请先登录管理员后台", "admin_login_required");
  const sql = db();
  const rows = await sql`SELECT 1 FROM admin_sessions WHERE token_hash=${await hashValue(`admin:${sessionToken}`, sql)} AND expires_at>NOW()`;
  if (!rows.length) throw new AppError(401, "请先登录管理员后台", "admin_login_required");
  return sessionToken;
}

async function adminDashboard() {
  const sql = db();
  await cleanup(sql);
  const rows = await sql`SELECT * FROM activities ORDER BY created_at DESC`;
  const activities = [];
  for (const row of rows) activities.push(await activityPayload(row, true, sql));
  const [summary] = await sql`SELECT COUNT(*)::int AS total_codes,
    COUNT(*) FILTER (WHERE status IN ('pending','verified'))::int AS active_codes,
    COALESCE(SUM(success_reports),0)::int AS successes,
    COALESCE(SUM(failure_reports+mismatch_reports),0)::int AS issues FROM codes`;
  return { activities, summary, settings: await publicSettings(sql) };
}

function normalizeActivityData(data: Json): Json {
  const title = String(data.title || "").trim();
  if (!title) throw new AppError(400, "请填写活动名称");
  let slug = String(data.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = `activity-${token(4).toLowerCase()}`;
  if (!["numeric","options","single"].includes(data.reward_mode)) throw new AppError(400, "奖励模式无效");
  if (!["draft","published","paused","ended"].includes(data.status)) throw new AppError(400, "活动状态无效");
  const startsAt = data.starts_at ? new Date(data.starts_at) : null;
  const endsAt = data.ends_at ? new Date(data.ends_at) : null;
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) throw new AppError(400, "日期格式不正确");
  if (startsAt && endsAt && startsAt >= endsAt) throw new AppError(400, "结束时间必须晚于开始时间");
  const numbers: Json = {};
  for (const [key, fallback, low, high] of [["code_capacity",10,1,100],["daily_claim_browser",2,1,100],["daily_submit_browser",3,1,100],["daily_submit_ip",30,1,1000]] as any[]) {
    const value = Number(data[key] ?? fallback);
    if (!Number.isInteger(value) || value < low || value > high) throw new AppError(400, "活动次数配置无效");
    numbers[key] = value;
  }
  if (!Array.isArray(data.tiers) || !data.tiers.length) throw new AppError(400, "至少配置一个奖励档位");
  return { ...data, title, slug, startsAt, endsAt, ...numbers, scopes: data.scopes || [], reward_options: data.reward_options || [] };
}

async function saveActivity(raw: Json, activityId?: number) {
  const data = normalizeActivityData(raw);
  const sql = db();
  try {
    return await sql.begin(async (tx) => {
      let id = activityId;
      if (id) {
        const exists = await tx`SELECT id FROM activities WHERE id=${id}`;
        if (!exists.length) throw new AppError(404, "活动不存在");
        const [{ count }] = await tx`SELECT COUNT(*)::int AS count FROM codes WHERE activity_id=${id}`;
        if (count) throw new AppError(409, "活动已有口令，只能暂停或结束；暂不允许重写档位配置");
        await tx`UPDATE activities SET slug=${data.slug},title=${data.title},summary=${String(data.summary || "").trim()},
          description=${String(data.description || "").trim()},status=${data.status},starts_at=${data.startsAt},ends_at=${data.endsAt},
          reward_mode=${data.reward_mode},reward_unit=${String(data.reward_unit || "活动奖励").trim()},code_capacity=${data.code_capacity},
          daily_claim_browser=${data.daily_claim_browser},daily_submit_browser=${data.daily_submit_browser},daily_submit_ip=${data.daily_submit_ip},updated_at=NOW()
          WHERE id=${id}`;
        await tx`DELETE FROM reward_options WHERE activity_id=${id}`;
        await tx`DELETE FROM tiers WHERE activity_id=${id}`;
        await tx`DELETE FROM scopes WHERE activity_id=${id}`;
      } else {
        const [created] = await tx`INSERT INTO activities ${tx({
          slug: data.slug, title: data.title, summary: String(data.summary || "").trim(), description: String(data.description || "").trim(),
          status: data.status, starts_at: data.startsAt, ends_at: data.endsAt, reward_mode: data.reward_mode,
          reward_unit: String(data.reward_unit || "活动奖励").trim(), code_capacity: data.code_capacity,
          daily_claim_browser: data.daily_claim_browser, daily_submit_browser: data.daily_submit_browser, daily_submit_ip: data.daily_submit_ip
        })} RETURNING id`;
        id = created.id;
      }
      const tierIds = [];
      for (let index = 0; index < data.tiers.length; index++) {
        const tier = data.tiers[index];
        const [created] = await tx`INSERT INTO tiers ${tx({ activity_id: id, name: String(tier.name || `档位${index + 1}`).trim(), min_value: tier.min_value, max_value: tier.max_value, sort_order: index })} RETURNING id`;
        tierIds.push(created.id);
      }
      for (let index = 0; index < data.scopes.length; index++) {
        const scope = data.scopes[index];
        const label = String(typeof scope === "object" ? scope.label : scope).trim();
        if (label) await tx`INSERT INTO scopes ${tx({ activity_id: id, label, sort_order: index })}`;
      }
      if (data.reward_mode === "options") {
        for (let index = 0; index < data.reward_options.length; index++) {
          const option = data.reward_options[index];
          const tierIndex = Number(option.tier_index || 0);
          if (!tierIds[tierIndex]) throw new AppError(400, "奖励选项关联的档位无效");
          await tx`INSERT INTO reward_options ${tx({ activity_id: id, tier_id: tierIds[tierIndex], label: String(option.label || "").trim(), sort_order: index })}`;
        }
      }
      if (data.status === "ended") await tx`UPDATE codes SET status='expired',updated_at=NOW() WHERE activity_id=${id} AND status IN ('pending','verified','paused','exhausted')`;
      return { id };
    });
  } catch (error: any) {
    if (error.code === "23505") throw new AppError(409, "活动短链接已被使用");
    throw error;
  }
}

async function adminCodes(activityId?: number) {
  const sql = db();
  return activityId
    ? sql`SELECT c.id,c.activity_id,c.code_value,c.reward_value,c.remaining,c.capacity,c.status,c.success_reports,c.failure_reports,c.mismatch_reports,c.created_at,
        a.title AS activity_title,t.name AS tier_name,s.label AS scope_label,o.label AS reward_label
        FROM codes c JOIN activities a ON a.id=c.activity_id LEFT JOIN tiers t ON t.id=c.tier_id
        LEFT JOIN scopes s ON s.id=c.scope_id LEFT JOIN reward_options o ON o.id=c.reward_option_id
        WHERE c.activity_id=${activityId} ORDER BY c.created_at DESC LIMIT 500`
    : sql`SELECT c.id,c.activity_id,c.code_value,c.reward_value,c.remaining,c.capacity,c.status,c.success_reports,c.failure_reports,c.mismatch_reports,c.created_at,
        a.title AS activity_title,t.name AS tier_name,s.label AS scope_label,o.label AS reward_label
        FROM codes c JOIN activities a ON a.id=c.activity_id LEFT JOIN tiers t ON t.id=c.tier_id
        LEFT JOIN scopes s ON s.id=c.scope_id LEFT JOIN reward_options o ON o.id=c.reward_option_id
        ORDER BY c.created_at DESC LIMIT 500`;
}

async function saveSettings(data: Json) {
  const allowed = ["site_name","site_notice","terms","claim_notice","sponsor_enabled","sponsor_title","sponsor_text","sponsor_qr"];
  const sql = db();
  for (const key of allowed) {
    if (!(key in data)) continue;
    if (key === "sponsor_qr" && String(data[key]).length > 2_000_000) throw new AppError(413, "二维码图片过大");
    await sql`INSERT INTO settings (key,value,updated_at) VALUES (${key},${sql.json(data[key])},NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`;
  }
  return { saved: true };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema();
    const path = routePath(req);
    const method = req.method || "GET";
    const body = () => requestBody(req);
    if (method === "GET" && path === "/bootstrap") return send(res, 200, await bootstrap());
    let match = path.match(/^\/activities\/(\d+)$/);
    if (method === "GET" && match) return send(res, 200, await getPublicActivity(Number(match[1])));
    match = path.match(/^\/activities\/(\d+)\/codes$/);
    if (method === "POST" && match) return send(res, 201, await submitCode(Number(match[1]), body(), await identity(req)));
    match = path.match(/^\/activities\/(\d+)\/claim$/);
    if (method === "POST" && match) return send(res, 201, await reserveClaim(Number(match[1]), body(), await identity(req)));
    match = path.match(/^\/claims\/(\d+)\/(confirm|cancel|feedback)$/);
    if (method === "POST" && match) {
      const data = body(); const id = Number(match[1]);
      if (match[2] === "confirm") return send(res, 200, await confirmClaim(id, String(data.claim_token || "")));
      if (match[2] === "cancel") return send(res, 200, await cancelClaim(id, String(data.claim_token || "")));
      return send(res, 200, await saveFeedback(id, String(data.claim_token || ""), String(data.feedback || "")));
    }
    if (method === "POST" && path === "/my/submissions") return send(res, 200, { items: await mySubmissions(body().owner_tokens || []) });
    match = path.match(/^\/codes\/(\d+)\/withdraw$/);
    if (method === "POST" && match) return send(res, 200, await withdrawCode(Number(match[1]), String(body().owner_token || "")));

    if (method === "POST" && path === "/admin/login") {
      const sessionToken = await adminLogin(String(body().password || ""));
      return send(res, 200, { authenticated: true }, `admin_session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
    }
    if (method === "POST" && path === "/admin/logout") {
      const sessionToken = parseCookies(req).admin_session;
      if (sessionToken) await db()`DELETE FROM admin_sessions WHERE token_hash=${await hashValue(`admin:${sessionToken}`)}`;
      return send(res, 200, { authenticated: false }, "admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    }
    if (path.startsWith("/admin/")) await requireAdmin(req);
    if (method === "GET" && path === "/admin/dashboard") return send(res, 200, await adminDashboard());
    if (method === "GET" && path === "/admin/codes") return send(res, 200, { items: await adminCodes(req.query.activity_id ? Number(req.query.activity_id) : undefined) });
    if (method === "POST" && path === "/admin/activities") return send(res, 201, await saveActivity(body()));
    match = path.match(/^\/admin\/activities\/(\d+)$/);
    if (method === "PUT" && match) return send(res, 200, await saveActivity(body(), Number(match[1])));
    match = path.match(/^\/admin\/codes\/(\d+)\/status$/);
    if (method === "POST" && match) {
      const status = String(body().status || "");
      if (!["pending","verified","paused","withdrawn","exhausted","expired"].includes(status)) throw new AppError(400, "口令状态无效");
      const sql = db();
      const rows = await sql`SELECT remaining FROM codes WHERE id=${Number(match[1])}`;
      if (!rows.length) throw new AppError(404, "口令不存在");
      const savedStatus = ["pending","verified"].includes(status) && rows[0].remaining <= 0 ? "exhausted" : status;
      await sql`UPDATE codes SET status=${savedStatus},updated_at=NOW() WHERE id=${Number(match[1])}`;
      return send(res, 200, { saved: true, status: savedStatus });
    }
    if (method === "PUT" && path === "/admin/settings") return send(res, 200, await saveSettings(body()));
    throw new AppError(404, "接口不存在");
  } catch (error: any) {
    console.error(error);
    if (error instanceof AppError) return send(res, error.status, { error: error.message, code: error.code });
    return send(res, 500, { error: "服务器暂时出现问题，请稍后重试", code: "server_error" });
  }
}
