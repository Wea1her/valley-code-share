import crypto from "node:crypto";
import postgres from "postgres";

const baseUrl = process.env.BASE_URL || "https://valley-code-share.vercel.app";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require" });
let activityId;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error || text}`);
  return body;
}

try {
  const slug = `smoke-${Date.now()}`;
  const [activity] = await sql`
    INSERT INTO activities (slug,title,summary,description,status,starts_at,ends_at,reward_mode,reward_unit)
    VALUES (${slug},'部署冒烟测试','自动测试','自动清理','published',NOW()-INTERVAL '1 hour',NOW()+INTERVAL '1 hour','numeric','测试代币')
    RETURNING id`;
  activityId = activity.id;
  const [tier] = await sql`INSERT INTO tiers (activity_id,name,min_value,max_value,sort_order)
    VALUES (${activityId},'测试档位',0,NULL,0) RETURNING id`;

  const submitVisitor = `smoke-submit-${crypto.randomUUID()}`;
  const claimVisitor = `smoke-claim-${crypto.randomUUID()}`;
  const submitted = await request(`/api/activities/${activityId}/codes`, {
    method: "POST",
    headers: { "X-Visitor-ID": submitVisitor },
    body: JSON.stringify({ code: `SMOKE${Date.now()}`, reward_value: 600, terms_accepted: true })
  });
  if (submitted.remaining !== 10) throw new Error("New code did not start with 10 claims");

  const claimed = await request(`/api/activities/${activityId}/claim`, {
    method: "POST",
    headers: { "X-Visitor-ID": claimVisitor },
    body: JSON.stringify({ tier_id: tier.id, notice_accepted: true })
  });
  await request(`/api/claims/${claimed.claim_id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ claim_token: claimed.claim_token })
  });
  const feedback = await request(`/api/claims/${claimed.claim_id}/feedback`, {
    method: "POST",
    body: JSON.stringify({ claim_token: claimed.claim_token, feedback: "success" })
  });
  if (feedback.code_status !== "verified") throw new Error("Success feedback did not verify code");

  console.log(JSON.stringify({ status: "ok", submit: true, claim: true, feedback: true }));
} finally {
  if (activityId) await sql`DELETE FROM activities WHERE id=${activityId}`;
  await sql.end();
}
