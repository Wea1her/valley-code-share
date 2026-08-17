from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DEFAULT_DB = DATA_DIR / "codes.sqlite3"
SHANGHAI = timezone(timedelta(hours=8))
CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
VISITOR_PATTERN = re.compile(r"^[A-Za-z0-9-]{16,80}$")


class AppError(Exception):
    def __init__(self, status: int, message: str, code: str = "request_error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None = None) -> str:
    value = value or utc_now()
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AppError(400, "日期格式不正确") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SHANGHAI)
    return parsed.astimezone(timezone.utc)


def normalize_code(value: str) -> str:
    return re.sub(r"\s+", "", value or "").upper()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


@dataclass
class RequestIdentity:
    visitor_hash: str
    ip_hash: str
    visitor_id: str


class CodePoolApp:
    def __init__(self, db_path: Path = DEFAULT_DB, admin_password: str | None = None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.admin_password = admin_password or os.environ.get("ADMIN_PASSWORD", "admin123")
        self._lock = threading.RLock()
        self._init_database()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
        finally:
            connection.close()

    def _init_database(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','published','paused','ended')),
                    starts_at TEXT,
                    ends_at TEXT,
                    reward_mode TEXT NOT NULL DEFAULT 'numeric'
                        CHECK(reward_mode IN ('numeric','options','single')),
                    reward_unit TEXT NOT NULL DEFAULT '活动代币',
                    code_capacity INTEGER NOT NULL DEFAULT 10 CHECK(code_capacity BETWEEN 1 AND 100),
                    daily_claim_browser INTEGER NOT NULL DEFAULT 2 CHECK(daily_claim_browser BETWEEN 1 AND 100),
                    daily_submit_browser INTEGER NOT NULL DEFAULT 3 CHECK(daily_submit_browser BETWEEN 1 AND 100),
                    daily_submit_ip INTEGER NOT NULL DEFAULT 30 CHECK(daily_submit_ip BETWEEN 1 AND 1000),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tiers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    min_value REAL,
                    max_value REAL,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS reward_options (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                    tier_id INTEGER REFERENCES tiers(id) ON DELETE SET NULL,
                    label TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS scopes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                    label TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                    code_value TEXT,
                    code_hash TEXT NOT NULL,
                    reward_value REAL,
                    reward_option_id INTEGER REFERENCES reward_options(id) ON DELETE SET NULL,
                    tier_id INTEGER REFERENCES tiers(id) ON DELETE SET NULL,
                    scope_id INTEGER REFERENCES scopes(id) ON DELETE SET NULL,
                    remaining INTEGER NOT NULL,
                    capacity INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','verified','paused','withdrawn','exhausted','expired')),
                    owner_token_hash TEXT NOT NULL,
                    submitter_visitor_hash TEXT NOT NULL,
                    submitter_ip_hash TEXT NOT NULL,
                    success_reports INTEGER NOT NULL DEFAULT 0,
                    failure_reports INTEGER NOT NULL DEFAULT 0,
                    mismatch_reports INTEGER NOT NULL DEFAULT 0,
                    last_success_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(activity_id, code_hash)
                );

                CREATE TABLE IF NOT EXISTS claims (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code_id INTEGER NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
                    visitor_hash TEXT NOT NULL,
                    ip_hash TEXT NOT NULL,
                    claim_token_hash TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL DEFAULT 'reserved'
                        CHECK(state IN ('reserved','confirmed','cancelled','released')),
                    feedback TEXT CHECK(feedback IN ('success','invalid','mismatch')),
                    reserved_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    confirmed_at TEXT,
                    feedback_at TEXT,
                    UNIQUE(code_id, visitor_hash)
                );

                CREATE TABLE IF NOT EXISTS admin_sessions (
                    token_hash TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_codes_pool
                    ON codes(activity_id, tier_id, scope_id, status, remaining);
                CREATE INDEX IF NOT EXISTS idx_codes_submitter_day
                    ON codes(activity_id, submitter_visitor_hash, created_at);
                CREATE INDEX IF NOT EXISTS idx_claims_visitor_day
                    ON claims(visitor_hash, confirmed_at);
                """
            )
            now = iso_utc()
            defaults = {
                "site_name": "峡谷口令互助",
                "site_notice": "非官方玩家互助工具，与腾讯及《王者荣耀》官方无关联；口令有效性以游戏内结果为准。",
                "terms": "我确认口令来源合法、填写信息真实，并同意平台的匿名互助规则。",
                "claim_notice": "口令可能因站外领取而提前失效，实际结果以游戏内为准。",
                "sponsor_enabled": False,
                "sponsor_title": "赞助作者",
                "sponsor_text": "如果这个小工具帮到了你，可以自愿赞助它继续维护。",
                "sponsor_qr": "",
                "secret": secrets.token_hex(32),
            }
            for key, value in defaults.items():
                db.execute(
                    "INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,?,?)",
                    (key, json_dumps(value), now),
                )
            count = db.execute("SELECT COUNT(*) AS total FROM activities").fetchone()["total"]
            if count == 0:
                self._seed_demo(db)

    def _seed_demo(self, db: sqlite3.Connection) -> None:
        now = iso_utc()
        cursor = db.execute(
            """
            INSERT INTO activities(
                slug,title,summary,description,status,starts_at,ends_at,reward_mode,reward_unit,
                code_capacity,daily_claim_browser,daily_submit_browser,daily_submit_ip,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "farm-demo",
                "农活口令互助（演示）",
                "一个尚未发布的演示活动，可在后台修改配置。",
                "选择奖励档位后，系统会自动分配仍有次数的口令。",
                "draft",
                "2026-08-17T00:00:00+08:00",
                "2026-08-19T23:59:59+08:00",
                "numeric",
                "活动代币",
                10,
                2,
                3,
                30,
                now,
                now,
            ),
        )
        activity_id = cursor.lastrowid
        tiers = [("普通", 0, 299, 1), ("较高", 300, 599, 2), ("稀有", 600, None, 3)]
        db.executemany(
            "INSERT INTO tiers(activity_id,name,min_value,max_value,sort_order) VALUES(?,?,?,?,?)",
            [(activity_id, *tier) for tier in tiers],
        )
        db.executemany(
            "INSERT INTO scopes(activity_id,label,sort_order) VALUES(?,?,?)",
            [(activity_id, "微信区", 1), (activity_id, "QQ区", 2)],
        )

    def setting(self, db: sqlite3.Connection, key: str, default: Any = None) -> Any:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def public_settings(self, db: sqlite3.Connection) -> dict[str, Any]:
        keys = [
            "site_name",
            "site_notice",
            "terms",
            "claim_notice",
            "sponsor_enabled",
            "sponsor_title",
            "sponsor_text",
            "sponsor_qr",
        ]
        return {key: self.setting(db, key) for key in keys}

    def hash_value(self, db: sqlite3.Connection, value: str) -> str:
        secret = self.setting(db, "secret", "local-secret").encode("utf-8")
        return hmac.new(secret, value.encode("utf-8"), hashlib.sha256).hexdigest()

    def identity(self, visitor_id: str, ip: str) -> RequestIdentity:
        if not VISITOR_PATTERN.fullmatch(visitor_id or ""):
            raise AppError(400, "浏览器标识无效，请刷新页面后重试", "invalid_visitor")
        with self.connect() as db:
            return RequestIdentity(
                visitor_hash=self.hash_value(db, f"visitor:{visitor_id}"),
                ip_hash=self.hash_value(db, f"ip:{ip}"),
                visitor_id=visitor_id,
            )

    def cleanup(self, db: sqlite3.Connection) -> None:
        now = iso_utc()
        expired = db.execute(
            "SELECT id,code_id FROM claims WHERE state='reserved' AND expires_at<?", (now,)
        ).fetchall()
        for claim in expired:
            db.execute("UPDATE claims SET state='released' WHERE id=?", (claim["id"],))
            code = db.execute("SELECT status,remaining,capacity FROM codes WHERE id=?", (claim["code_id"],)).fetchone()
            if code and code["status"] in ("pending", "verified", "exhausted"):
                new_remaining = min(code["capacity"], code["remaining"] + 1)
                new_status = "pending" if code["status"] == "exhausted" else code["status"]
                db.execute(
                    "UPDATE codes SET remaining=?,status=?,updated_at=? WHERE id=?",
                    (new_remaining, new_status, now, claim["code_id"]),
                )

        activities = db.execute(
            "SELECT id,ends_at FROM activities WHERE status='published' AND ends_at IS NOT NULL AND ends_at<?",
            (now,),
        ).fetchall()
        for activity in activities:
            db.execute("UPDATE activities SET status='ended',updated_at=? WHERE id=?", (now, activity["id"]))
            db.execute(
                "UPDATE codes SET status='expired',updated_at=? WHERE activity_id=? AND status IN ('pending','verified','paused','exhausted')",
                (now, activity["id"]),
            )

        cutoff = iso_utc(utc_now() - timedelta(days=30))
        db.execute(
            """
            UPDATE codes SET code_value=NULL,updated_at=?
            WHERE code_value IS NOT NULL AND activity_id IN (
                SELECT id FROM activities WHERE status='ended' AND ends_at IS NOT NULL AND ends_at<?
            )
            """,
            (now, cutoff),
        )
        db.execute("DELETE FROM admin_sessions WHERE expires_at<?", (now,))

    def activity_state(self, row: sqlite3.Row | dict[str, Any]) -> str:
        status = row["status"]
        if status != "published":
            return status
        now = utc_now()
        starts = parse_datetime(row["starts_at"])
        ends = parse_datetime(row["ends_at"])
        if starts and now < starts:
            return "upcoming"
        if ends and now >= ends:
            return "ended"
        return "active"

    def activity_payload(self, db: sqlite3.Connection, row: sqlite3.Row, include_config: bool = True) -> dict[str, Any]:
        payload = row_dict(row) or {}
        payload["public_state"] = self.activity_state(row)
        if include_config:
            payload["tiers"] = [
                row_dict(item)
                for item in db.execute(
                    "SELECT id,name,min_value,max_value,sort_order FROM tiers WHERE activity_id=? ORDER BY sort_order,id",
                    (row["id"],),
                ).fetchall()
            ]
            payload["reward_options"] = [
                row_dict(item)
                for item in db.execute(
                    "SELECT id,tier_id,label,sort_order FROM reward_options WHERE activity_id=? ORDER BY sort_order,id",
                    (row["id"],),
                ).fetchall()
            ]
            payload["scopes"] = [
                row_dict(item)
                for item in db.execute(
                    "SELECT id,label,sort_order FROM scopes WHERE activity_id=? ORDER BY sort_order,id",
                    (row["id"],),
                ).fetchall()
            ]
        return payload

    def bootstrap(self) -> dict[str, Any]:
        with self.connect() as db:
            self.cleanup(db)
            rows = db.execute(
                "SELECT * FROM activities WHERE status IN ('published','paused','ended') ORDER BY starts_at DESC,id DESC"
            ).fetchall()
            activities = []
            for row in rows:
                payload = self.activity_payload(db, row, include_config=False)
                stats = db.execute(
                    """
                    SELECT COUNT(*) AS codes,COALESCE(SUM(remaining),0) AS claims
                    FROM codes WHERE activity_id=? AND status IN ('pending','verified') AND remaining>0
                    """,
                    (row["id"],),
                ).fetchone()
                payload["available_codes"] = stats["codes"]
                payload["available_claims"] = stats["claims"]
                activities.append(payload)
            return {"settings": self.public_settings(db), "activities": activities}

    def public_activity(self, activity_id: int) -> dict[str, Any]:
        with self.connect() as db:
            self.cleanup(db)
            row = db.execute(
                "SELECT * FROM activities WHERE id=? AND status IN ('published','paused','ended')", (activity_id,)
            ).fetchone()
            if not row:
                raise AppError(404, "没有找到这个活动")
            payload = self.activity_payload(db, row)
            for tier in payload["tiers"]:
                stats = db.execute(
                    """
                    SELECT COUNT(*) AS codes,COALESCE(SUM(remaining),0) AS claims,
                           SUM(success_reports) AS successes,SUM(failure_reports+mismatch_reports) AS failures,
                           MAX(last_success_at) AS last_success_at
                    FROM codes
                    WHERE activity_id=? AND tier_id=? AND status IN ('pending','verified') AND remaining>0
                    """,
                    (activity_id, tier["id"]),
                ).fetchone()
                successes = stats["successes"] or 0
                failures = stats["failures"] or 0
                tier.update(
                    {
                        "available_codes": stats["codes"],
                        "available_claims": stats["claims"],
                        "success_rate": round(successes * 100 / (successes + failures)) if successes + failures >= 3 else None,
                        "last_success_at": stats["last_success_at"],
                    }
                )
            return {"activity": payload, "settings": self.public_settings(db)}

    def _active_activity(self, db: sqlite3.Connection, activity_id: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
        if not row:
            raise AppError(404, "没有找到这个活动")
        state = self.activity_state(row)
        if state != "active":
            messages = {
                "upcoming": "活动尚未开始",
                "paused": "活动暂时停止",
                "ended": "活动已经结束",
                "draft": "活动尚未发布",
            }
            raise AppError(409, messages.get(state, "活动当前不可操作"), "activity_unavailable")
        return row

    def _day_start(self) -> str:
        local_now = utc_now().astimezone(SHANGHAI)
        start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        return iso_utc(start)

    def submit_code(self, activity_id: int, data: dict[str, Any], identity: RequestIdentity) -> dict[str, Any]:
        code = normalize_code(str(data.get("code", "")))
        if not CODE_PATTERN.fullmatch(code):
            raise AppError(400, "口令需为4到64位字母、数字、短横线或下划线")
        if data.get("website"):
            raise AppError(400, "提交未通过验证")
        started_at = data.get("form_started_at")
        if started_at and time.time() - float(started_at) < 1.2:
            raise AppError(429, "提交过快，请稍后重试")
        if not data.get("terms_accepted"):
            raise AppError(400, "请先确认互助规则")

        owner_token = secrets.token_urlsafe(32)
        now = iso_utc()
        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self.cleanup(db)
                activity = self._active_activity(db, activity_id)
                day_start = self._day_start()
                browser_count = db.execute(
                    "SELECT COUNT(*) AS n FROM codes WHERE activity_id=? AND submitter_visitor_hash=? AND created_at>=?",
                    (activity_id, identity.visitor_hash, day_start),
                ).fetchone()["n"]
                ip_count = db.execute(
                    "SELECT COUNT(*) AS n FROM codes WHERE activity_id=? AND submitter_ip_hash=? AND created_at>=?",
                    (activity_id, identity.ip_hash, day_start),
                ).fetchone()["n"]
                if browser_count >= activity["daily_submit_browser"]:
                    raise AppError(429, "你今天在这个活动中提交的口令已达上限", "submit_limit")
                if ip_count >= activity["daily_submit_ip"]:
                    raise AppError(429, "当前网络今天提交过于频繁，请明天再试", "ip_submit_limit")

                tier_id, reward_value, option_id = self._resolve_reward(db, activity, data)
                scope_id = self._resolve_scope(db, activity_id, data.get("scope_id"))
                code_hash = self.hash_value(db, f"code:{activity_id}:{code}")
                try:
                    cursor = db.execute(
                        """
                        INSERT INTO codes(
                            activity_id,code_value,code_hash,reward_value,reward_option_id,tier_id,scope_id,
                            remaining,capacity,status,owner_token_hash,submitter_visitor_hash,submitter_ip_hash,
                            created_at,updated_at
                        ) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)
                        """,
                        (
                            activity_id,
                            code,
                            code_hash,
                            reward_value,
                            option_id,
                            tier_id,
                            scope_id,
                            activity["code_capacity"],
                            activity["code_capacity"],
                            self.hash_value(db, f"owner:{owner_token}"),
                            identity.visitor_hash,
                            identity.ip_hash,
                            now,
                            now,
                        ),
                    )
                except sqlite3.IntegrityError as exc:
                    raise AppError(409, "这个口令已经提交过了", "duplicate_code") from exc
                db.execute("COMMIT")
                return {"id": cursor.lastrowid, "owner_token": owner_token, "remaining": activity["code_capacity"]}
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _resolve_reward(
        self, db: sqlite3.Connection, activity: sqlite3.Row, data: dict[str, Any]
    ) -> tuple[int | None, float | None, int | None]:
        mode = activity["reward_mode"]
        if mode == "numeric":
            try:
                reward_value = float(data.get("reward_value"))
            except (TypeError, ValueError) as exc:
                raise AppError(400, "请填写正确的奖励数值") from exc
            tier = db.execute(
                """
                SELECT id FROM tiers
                WHERE activity_id=? AND (min_value IS NULL OR min_value<=?) AND (max_value IS NULL OR max_value>=?)
                ORDER BY sort_order,id LIMIT 1
                """,
                (activity["id"], reward_value, reward_value),
            ).fetchone()
            if not tier:
                raise AppError(400, "奖励数值不在管理员配置的档位范围内")
            return tier["id"], reward_value, None
        if mode == "options":
            try:
                option_id = int(data.get("reward_option_id"))
            except (TypeError, ValueError) as exc:
                raise AppError(400, "请选择奖励选项") from exc
            option = db.execute(
                "SELECT id,tier_id FROM reward_options WHERE id=? AND activity_id=?",
                (option_id, activity["id"]),
            ).fetchone()
            if not option:
                raise AppError(400, "奖励选项无效")
            return option["tier_id"], None, option["id"]
        tier = db.execute(
            "SELECT id FROM tiers WHERE activity_id=? ORDER BY sort_order,id LIMIT 1", (activity["id"],)
        ).fetchone()
        return (tier["id"] if tier else None), None, None

    def _resolve_scope(self, db: sqlite3.Connection, activity_id: int, raw_scope: Any) -> int | None:
        count = db.execute("SELECT COUNT(*) AS n FROM scopes WHERE activity_id=?", (activity_id,)).fetchone()["n"]
        if count == 0:
            return None
        try:
            scope_id = int(raw_scope)
        except (TypeError, ValueError) as exc:
            raise AppError(400, "请选择口令适用范围") from exc
        row = db.execute("SELECT id FROM scopes WHERE id=? AND activity_id=?", (scope_id, activity_id)).fetchone()
        if not row:
            raise AppError(400, "适用范围无效")
        return scope_id

    def reserve_claim(self, activity_id: int, data: dict[str, Any], identity: RequestIdentity) -> dict[str, Any]:
        if not data.get("notice_accepted"):
            raise AppError(400, "请先确认领取提示")
        try:
            tier_id = int(data.get("tier_id"))
        except (TypeError, ValueError) as exc:
            raise AppError(400, "请选择奖励档位") from exc
        claim_token = secrets.token_urlsafe(32)
        now_dt = utc_now()
        now = iso_utc(now_dt)
        expires = iso_utc(now_dt + timedelta(minutes=2))

        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self.cleanup(db)
                activity = self._active_activity(db, activity_id)
                tier = db.execute("SELECT id FROM tiers WHERE id=? AND activity_id=?", (tier_id, activity_id)).fetchone()
                if not tier:
                    raise AppError(400, "奖励档位无效")
                scope_id = self._resolve_scope(db, activity_id, data.get("scope_id"))
                day_start = self._day_start()
                used = db.execute(
                    """
                    SELECT COUNT(*) AS n FROM claims c JOIN codes x ON x.id=c.code_id
                    WHERE x.activity_id=? AND c.visitor_hash=? AND c.state IN ('reserved','confirmed')
                      AND c.reserved_at>=?
                    """,
                    (activity_id, identity.visitor_hash, day_start),
                ).fetchone()["n"]
                if used >= activity["daily_claim_browser"]:
                    raise AppError(429, "你今天在这个活动中的领取次数已达上限", "claim_limit")

                parameters: list[Any] = [activity_id, tier_id, identity.visitor_hash]
                scope_sql = "AND c.scope_id IS NULL" if scope_id is None else "AND c.scope_id=?"
                if scope_id is not None:
                    parameters.append(scope_id)
                candidate = db.execute(
                    f"""
                    SELECT c.* FROM codes c
                    WHERE c.activity_id=? AND c.tier_id=? AND c.status IN ('pending','verified') AND c.remaining>0
                      AND NOT EXISTS(SELECT 1 FROM claims q WHERE q.code_id=c.id AND q.visitor_hash=?)
                      {scope_sql}
                    ORDER BY c.remaining ASC, RANDOM() LIMIT 1
                    """,
                    parameters,
                ).fetchone()
                if not candidate:
                    raise AppError(404, "这个档位暂时没有可领取的口令", "pool_empty")
                new_remaining = candidate["remaining"] - 1
                new_status = "exhausted" if new_remaining == 0 else candidate["status"]
                db.execute(
                    "UPDATE codes SET remaining=?,status=?,updated_at=? WHERE id=?",
                    (new_remaining, new_status, now, candidate["id"]),
                )
                cursor = db.execute(
                    """
                    INSERT INTO claims(code_id,visitor_hash,ip_hash,claim_token_hash,state,reserved_at,expires_at)
                    VALUES(?,?,?,?,?,?,?)
                    """,
                    (
                        candidate["id"],
                        identity.visitor_hash,
                        identity.ip_hash,
                        self.hash_value(db, f"claim:{claim_token}"),
                        "reserved",
                        now,
                        expires,
                    ),
                )
                option = None
                if candidate["reward_option_id"]:
                    option = db.execute("SELECT label FROM reward_options WHERE id=?", (candidate["reward_option_id"],)).fetchone()
                scope = None
                if candidate["scope_id"]:
                    scope = db.execute("SELECT label FROM scopes WHERE id=?", (candidate["scope_id"],)).fetchone()
                db.execute("COMMIT")
                return {
                    "claim_id": cursor.lastrowid,
                    "claim_token": claim_token,
                    "code": candidate["code_value"],
                    "reward_value": candidate["reward_value"],
                    "reward_label": option["label"] if option else None,
                    "scope_label": scope["label"] if scope else None,
                    "expires_at": expires,
                }
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _claim_by_token(self, db: sqlite3.Connection, claim_id: int, token: str) -> sqlite3.Row:
        token_hash = self.hash_value(db, f"claim:{token}")
        row = db.execute("SELECT * FROM claims WHERE id=? AND claim_token_hash=?", (claim_id, token_hash)).fetchone()
        if not row:
            raise AppError(404, "领取记录不存在")
        return row

    def confirm_claim(self, claim_id: int, token: str) -> dict[str, Any]:
        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self.cleanup(db)
                claim = self._claim_by_token(db, claim_id, token)
                if claim["state"] == "confirmed":
                    db.execute("COMMIT")
                    return {"confirmed": True}
                if claim["state"] != "reserved":
                    raise AppError(409, "这个口令预留已经失效，请重新领取")
                now = iso_utc()
                db.execute("UPDATE claims SET state='confirmed',confirmed_at=? WHERE id=?", (now, claim_id))
                db.execute("COMMIT")
                return {"confirmed": True}
            except Exception:
                db.execute("ROLLBACK")
                raise

    def cancel_claim(self, claim_id: int, token: str) -> dict[str, Any]:
        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                claim = self._claim_by_token(db, claim_id, token)
                if claim["state"] != "reserved":
                    db.execute("COMMIT")
                    return {"released": claim["state"] in ("cancelled", "released")}
                now = iso_utc()
                db.execute("UPDATE claims SET state='cancelled' WHERE id=?", (claim_id,))
                code = db.execute("SELECT * FROM codes WHERE id=?", (claim["code_id"],)).fetchone()
                if code and code["status"] in ("pending", "verified", "exhausted"):
                    status = "pending" if code["status"] == "exhausted" else code["status"]
                    db.execute(
                        "UPDATE codes SET remaining=MIN(capacity,remaining+1),status=?,updated_at=? WHERE id=?",
                        (status, now, code["id"]),
                    )
                db.execute("COMMIT")
                return {"released": True}
            except Exception:
                db.execute("ROLLBACK")
                raise

    def feedback(self, claim_id: int, token: str, feedback: str) -> dict[str, Any]:
        if feedback not in ("success", "invalid", "mismatch"):
            raise AppError(400, "反馈类型无效")
        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                claim = self._claim_by_token(db, claim_id, token)
                if claim["state"] != "confirmed":
                    raise AppError(409, "只有复制成功的口令才能反馈")
                if claim["feedback"]:
                    raise AppError(409, "你已经反馈过这个口令")
                now = iso_utc()
                db.execute(
                    "UPDATE claims SET feedback=?,feedback_at=? WHERE id=?", (feedback, now, claim_id)
                )
                column = {"success": "success_reports", "invalid": "failure_reports", "mismatch": "mismatch_reports"}[feedback]
                db.execute(f"UPDATE codes SET {column}={column}+1,updated_at=? WHERE id=?", (now, claim["code_id"]))
                if feedback == "success":
                    db.execute(
                        "UPDATE codes SET status=CASE WHEN status='pending' THEN 'verified' ELSE status END,last_success_at=? WHERE id=?",
                        (now, claim["code_id"]),
                    )
                else:
                    reporters = db.execute(
                        """
                        SELECT COUNT(DISTINCT visitor_hash) AS visitors,COUNT(DISTINCT ip_hash) AS ips
                        FROM claims WHERE code_id=? AND feedback=?
                        """,
                        (claim["code_id"], feedback),
                    ).fetchone()
                    if reporters["visitors"] >= 2 and reporters["ips"] >= 2:
                        db.execute(
                            "UPDATE codes SET status='paused',updated_at=? WHERE id=? AND status IN ('pending','verified','exhausted')",
                            (now, claim["code_id"]),
                        )
                code = db.execute("SELECT status FROM codes WHERE id=?", (claim["code_id"],)).fetchone()
                db.execute("COMMIT")
                return {"saved": True, "code_status": code["status"]}
            except Exception:
                db.execute("ROLLBACK")
                raise

    def my_submissions(self, owner_tokens: list[str]) -> list[dict[str, Any]]:
        if not owner_tokens:
            return []
        with self.connect() as db:
            hashes = [self.hash_value(db, f"owner:{token}") for token in owner_tokens[:100]]
            placeholders = ",".join("?" for _ in hashes)
            rows = db.execute(
                f"""
                SELECT c.id,c.activity_id,c.reward_value,c.remaining,c.capacity,c.status,c.created_at,
                       a.title AS activity_title,t.name AS tier_name,s.label AS scope_label,o.label AS reward_label
                FROM codes c JOIN activities a ON a.id=c.activity_id
                LEFT JOIN tiers t ON t.id=c.tier_id LEFT JOIN scopes s ON s.id=c.scope_id
                LEFT JOIN reward_options o ON o.id=c.reward_option_id
                WHERE c.owner_token_hash IN ({placeholders}) ORDER BY c.created_at DESC
                """,
                hashes,
            ).fetchall()
            return [row_dict(row) for row in rows]

    def withdraw_code(self, code_id: int, owner_token: str) -> dict[str, Any]:
        with self.connect() as db:
            owner_hash = self.hash_value(db, f"owner:{owner_token}")
            row = db.execute("SELECT id,status FROM codes WHERE id=? AND owner_token_hash=?", (code_id, owner_hash)).fetchone()
            if not row:
                raise AppError(404, "没有找到可撤回的口令")
            if row["status"] in ("withdrawn", "expired"):
                return {"withdrawn": True}
            db.execute("UPDATE codes SET status='withdrawn',updated_at=? WHERE id=?", (iso_utc(), code_id))
            return {"withdrawn": True}

    def admin_login(self, password: str) -> str:
        if not hmac.compare_digest(password or "", self.admin_password):
            raise AppError(401, "管理员密码不正确")
        token = secrets.token_urlsafe(32)
        with self.connect() as db:
            now = utc_now()
            db.execute(
                "INSERT INTO admin_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)",
                (self.hash_value(db, f"admin:{token}"), iso_utc(now), iso_utc(now + timedelta(hours=12))),
            )
        return token

    def admin_authenticated(self, token: str | None) -> bool:
        if not token:
            return False
        with self.connect() as db:
            token_hash = self.hash_value(db, f"admin:{token}")
            row = db.execute(
                "SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?", (token_hash, iso_utc())
            ).fetchone()
            return bool(row)

    def admin_logout(self, token: str | None) -> None:
        if not token:
            return
        with self.connect() as db:
            db.execute("DELETE FROM admin_sessions WHERE token_hash=?", (self.hash_value(db, f"admin:{token}"),))

    def admin_dashboard(self) -> dict[str, Any]:
        with self.connect() as db:
            self.cleanup(db)
            activities = [
                self.activity_payload(db, row)
                for row in db.execute("SELECT * FROM activities ORDER BY created_at DESC").fetchall()
            ]
            summary = db.execute(
                """
                SELECT COUNT(*) AS total_codes,
                       SUM(CASE WHEN status IN ('pending','verified') THEN 1 ELSE 0 END) AS active_codes,
                       SUM(success_reports) AS successes,
                       SUM(failure_reports+mismatch_reports) AS issues
                FROM codes
                """
            ).fetchone()
            return {"activities": activities, "summary": row_dict(summary), "settings": self.public_settings(db)}

    def save_activity(self, data: dict[str, Any], activity_id: int | None = None) -> dict[str, Any]:
        title = str(data.get("title", "")).strip()
        if not title:
            raise AppError(400, "请填写活动名称")
        slug = re.sub(r"[^a-z0-9-]+", "-", str(data.get("slug", "")).strip().lower()).strip("-")
        if not slug:
            slug = f"activity-{secrets.token_hex(3)}"
        reward_mode = data.get("reward_mode", "numeric")
        if reward_mode not in ("numeric", "options", "single"):
            raise AppError(400, "奖励模式无效")
        starts = iso_utc(parse_datetime(data.get("starts_at"))) if data.get("starts_at") else None
        ends = iso_utc(parse_datetime(data.get("ends_at"))) if data.get("ends_at") else None
        if starts and ends and starts >= ends:
            raise AppError(400, "结束时间必须晚于开始时间")
        status = data.get("status", "draft")
        if status not in ("draft", "published", "paused", "ended"):
            raise AppError(400, "活动状态无效")
        integers = {}
        for key, default, low, high in (
            ("code_capacity", 10, 1, 100),
            ("daily_claim_browser", 2, 1, 100),
            ("daily_submit_browser", 3, 1, 100),
            ("daily_submit_ip", 30, 1, 1000),
        ):
            try:
                value = int(data.get(key, default))
            except (TypeError, ValueError) as exc:
                raise AppError(400, "活动次数配置无效") from exc
            if not low <= value <= high:
                raise AppError(400, "活动次数配置超出允许范围")
            integers[key] = value
        tiers = data.get("tiers") or []
        if not tiers:
            raise AppError(400, "至少配置一个奖励档位")
        scopes = data.get("scopes") or []
        options = data.get("reward_options") or []
        now = iso_utc()
        with self._lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                rebuild_config = True
                if activity_id:
                    existing = db.execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
                    if not existing:
                        raise AppError(404, "活动不存在")
                    code_count = db.execute(
                        "SELECT COUNT(*) AS n FROM codes WHERE activity_id=?", (activity_id,)
                    ).fetchone()["n"]
                    if code_count:
                        current_tiers = db.execute(
                            "SELECT id,name,min_value,max_value FROM tiers WHERE activity_id=? ORDER BY sort_order,id",
                            (activity_id,),
                        ).fetchall()
                        current_tier_index = {tier["id"]: index for index, tier in enumerate(current_tiers)}
                        current_options = db.execute(
                            "SELECT label,tier_id FROM reward_options WHERE activity_id=? ORDER BY sort_order,id",
                            (activity_id,),
                        ).fetchall()
                        current_scopes = db.execute(
                            "SELECT label FROM scopes WHERE activity_id=? ORDER BY sort_order,id", (activity_id,)
                        ).fetchall()
                        incoming_tiers = [
                            (
                                str(tier.get("name", f"档位{index + 1}")).strip(),
                                tier.get("min_value"),
                                tier.get("max_value"),
                            )
                            for index, tier in enumerate(tiers)
                        ]
                        incoming_scopes = [
                            str(scope.get("label", scope) if isinstance(scope, dict) else scope).strip()
                            for scope in scopes
                            if str(scope.get("label", scope) if isinstance(scope, dict) else scope).strip()
                        ]
                        incoming_options = [
                            (str(option.get("label", "")).strip(), int(option.get("tier_index", 0)))
                            for option in options
                        ] if reward_mode == "options" else []
                        stored_tiers = [(row["name"], row["min_value"], row["max_value"]) for row in current_tiers]
                        stored_scopes = [row["label"] for row in current_scopes]
                        stored_options = [
                            (row["label"], current_tier_index.get(row["tier_id"], -1)) for row in current_options
                        ]
                        structural_change = any(
                            (
                                reward_mode != existing["reward_mode"],
                                integers["code_capacity"] != existing["code_capacity"],
                                incoming_tiers != stored_tiers,
                                incoming_scopes != stored_scopes,
                                incoming_options != stored_options,
                            )
                        )
                        if structural_change:
                            raise AppError(409, "活动已有口令，不能再修改奖励模式、档位、适用范围或每码次数")
                        rebuild_config = False
                    db.execute(
                        """
                        UPDATE activities SET slug=?,title=?,summary=?,description=?,status=?,starts_at=?,ends_at=?,
                          reward_mode=?,reward_unit=?,code_capacity=?,daily_claim_browser=?,daily_submit_browser=?,
                          daily_submit_ip=?,updated_at=? WHERE id=?
                        """,
                        (
                            slug,
                            title,
                            str(data.get("summary", "")).strip(),
                            str(data.get("description", "")).strip(),
                            status,
                            starts,
                            ends,
                            reward_mode,
                            str(data.get("reward_unit", "活动奖励")).strip(),
                            integers["code_capacity"],
                            integers["daily_claim_browser"],
                            integers["daily_submit_browser"],
                            integers["daily_submit_ip"],
                            now,
                            activity_id,
                        ),
                    )
                    if rebuild_config:
                        db.execute("DELETE FROM reward_options WHERE activity_id=?", (activity_id,))
                        db.execute("DELETE FROM tiers WHERE activity_id=?", (activity_id,))
                        db.execute("DELETE FROM scopes WHERE activity_id=?", (activity_id,))
                else:
                    cursor = db.execute(
                        """
                        INSERT INTO activities(slug,title,summary,description,status,starts_at,ends_at,reward_mode,reward_unit,
                          code_capacity,daily_claim_browser,daily_submit_browser,daily_submit_ip,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            slug,
                            title,
                            str(data.get("summary", "")).strip(),
                            str(data.get("description", "")).strip(),
                            status,
                            starts,
                            ends,
                            reward_mode,
                            str(data.get("reward_unit", "活动奖励")).strip(),
                            integers["code_capacity"],
                            integers["daily_claim_browser"],
                            integers["daily_submit_browser"],
                            integers["daily_submit_ip"],
                            now,
                            now,
                        ),
                    )
                    activity_id = cursor.lastrowid
                if rebuild_config:
                    tier_map: list[int] = []
                    for index, tier in enumerate(tiers):
                        cursor = db.execute(
                            "INSERT INTO tiers(activity_id,name,min_value,max_value,sort_order) VALUES(?,?,?,?,?)",
                            (
                                activity_id,
                                str(tier.get("name", f"档位{index + 1}")).strip(),
                                tier.get("min_value"),
                                tier.get("max_value"),
                                index,
                            ),
                        )
                        tier_map.append(cursor.lastrowid)
                    for index, scope in enumerate(scopes):
                        label = str(scope.get("label", scope) if isinstance(scope, dict) else scope).strip()
                        if label:
                            db.execute(
                                "INSERT INTO scopes(activity_id,label,sort_order) VALUES(?,?,?)", (activity_id, label, index)
                            )
                    if reward_mode == "options":
                        for index, option in enumerate(options):
                            tier_index = int(option.get("tier_index", 0))
                            if tier_index < 0 or tier_index >= len(tier_map):
                                raise AppError(400, "奖励选项关联的档位无效")
                            db.execute(
                                "INSERT INTO reward_options(activity_id,tier_id,label,sort_order) VALUES(?,?,?,?)",
                                (activity_id, tier_map[tier_index], str(option.get("label", "")).strip(), index),
                            )
                if status == "ended":
                    db.execute(
                        "UPDATE codes SET status='expired',updated_at=? WHERE activity_id=? AND status IN ('pending','verified','paused','exhausted')",
                        (now, activity_id),
                    )
                db.execute("COMMIT")
                return {"id": activity_id}
            except sqlite3.IntegrityError as exc:
                db.execute("ROLLBACK")
                raise AppError(409, "活动短链接已被使用") from exc
            except Exception:
                db.execute("ROLLBACK")
                raise

    def admin_codes(self, activity_id: int | None = None) -> list[dict[str, Any]]:
        with self.connect() as db:
            where = "WHERE c.activity_id=?" if activity_id else ""
            params = (activity_id,) if activity_id else ()
            rows = db.execute(
                f"""
                SELECT c.id,c.activity_id,c.code_value,c.reward_value,c.remaining,c.capacity,c.status,
                       c.success_reports,c.failure_reports,c.mismatch_reports,c.created_at,a.title AS activity_title,
                       t.name AS tier_name,s.label AS scope_label,o.label AS reward_label
                FROM codes c JOIN activities a ON a.id=c.activity_id
                LEFT JOIN tiers t ON t.id=c.tier_id LEFT JOIN scopes s ON s.id=c.scope_id
                LEFT JOIN reward_options o ON o.id=c.reward_option_id
                {where} ORDER BY c.created_at DESC LIMIT 500
                """,
                params,
            ).fetchall()
            return [row_dict(row) for row in rows]

    def admin_code_status(self, code_id: int, status: str) -> dict[str, Any]:
        if status not in ("pending", "verified", "paused", "withdrawn", "exhausted", "expired"):
            raise AppError(400, "口令状态无效")
        with self.connect() as db:
            row = db.execute("SELECT id,remaining FROM codes WHERE id=?", (code_id,)).fetchone()
            if not row:
                raise AppError(404, "口令不存在")
            if status in ("pending", "verified") and row["remaining"] <= 0:
                status = "exhausted"
            db.execute("UPDATE codes SET status=?,updated_at=? WHERE id=?", (status, iso_utc(), code_id))
            return {"saved": True, "status": status}

    def save_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "site_name",
            "site_notice",
            "terms",
            "claim_notice",
            "sponsor_enabled",
            "sponsor_title",
            "sponsor_text",
            "sponsor_qr",
        }
        now = iso_utc()
        with self.connect() as db:
            for key, value in data.items():
                if key not in allowed:
                    continue
                if key == "sponsor_qr" and isinstance(value, str) and len(value) > 2_000_000:
                    raise AppError(413, "二维码图片过大")
                db.execute(
                    """
                    INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
                    """,
                    (key, json_dumps(value), now),
                )
        return {"saved": True}


class AppRequestHandler(BaseHTTPRequestHandler):
    server_version = "ValleyCodes/0.1"

    @property
    def app(self) -> CodePoolApp:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def _dispatch(self, method: str) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            if path.startswith("/api/"):
                self._api(method, path, query)
            else:
                self._static(path)
        except AppError as exc:
            self._json(exc.status, {"error": exc.message, "code": exc.code})
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            traceback.print_exc()
            self._json(500, {"error": "服务器暂时出现问题，请稍后重试", "code": "server_error"})

    def _api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        if method == "GET" and path == "/api/bootstrap":
            return self._json(200, self.app.bootstrap())
        match = re.fullmatch(r"/api/activities/(\d+)", path)
        if method == "GET" and match:
            return self._json(200, self.app.public_activity(int(match.group(1))))
        match = re.fullmatch(r"/api/activities/(\d+)/codes", path)
        if method == "POST" and match:
            identity = self._identity()
            return self._json(201, self.app.submit_code(int(match.group(1)), self._body(), identity))
        match = re.fullmatch(r"/api/activities/(\d+)/claim", path)
        if method == "POST" and match:
            identity = self._identity()
            return self._json(201, self.app.reserve_claim(int(match.group(1)), self._body(), identity))
        match = re.fullmatch(r"/api/claims/(\d+)/(confirm|cancel|feedback)", path)
        if method == "POST" and match:
            body = self._body()
            claim_id = int(match.group(1))
            action = match.group(2)
            if action == "confirm":
                return self._json(200, self.app.confirm_claim(claim_id, str(body.get("claim_token", ""))))
            if action == "cancel":
                return self._json(200, self.app.cancel_claim(claim_id, str(body.get("claim_token", ""))))
            return self._json(
                200,
                self.app.feedback(claim_id, str(body.get("claim_token", "")), str(body.get("feedback", ""))),
            )
        if method == "POST" and path == "/api/my/submissions":
            return self._json(200, {"items": self.app.my_submissions(self._body().get("owner_tokens", []))})
        match = re.fullmatch(r"/api/codes/(\d+)/withdraw", path)
        if method == "POST" and match:
            return self._json(200, self.app.withdraw_code(int(match.group(1)), str(self._body().get("owner_token", ""))))

        if method == "POST" and path == "/api/admin/login":
            token = self.app.admin_login(str(self._body().get("password", "")))
            return self._json(
                200,
                {"authenticated": True},
                cookie=f"admin_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
            )
        if method == "POST" and path == "/api/admin/logout":
            token = self._admin_token()
            self.app.admin_logout(token)
            return self._json(
                200,
                {"authenticated": False},
                cookie="admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            )
        if path.startswith("/api/admin/"):
            self._require_admin()
        if method == "GET" and path == "/api/admin/dashboard":
            return self._json(200, self.app.admin_dashboard())
        if method == "GET" and path == "/api/admin/codes":
            activity_id = int(query["activity_id"][0]) if query.get("activity_id") else None
            return self._json(200, {"items": self.app.admin_codes(activity_id)})
        if method == "POST" and path == "/api/admin/activities":
            return self._json(201, self.app.save_activity(self._body()))
        match = re.fullmatch(r"/api/admin/activities/(\d+)", path)
        if method == "PUT" and match:
            return self._json(200, self.app.save_activity(self._body(), int(match.group(1))))
        match = re.fullmatch(r"/api/admin/codes/(\d+)/status", path)
        if method == "POST" and match:
            return self._json(200, self.app.admin_code_status(int(match.group(1)), str(self._body().get("status", ""))))
        if method == "PUT" and path == "/api/admin/settings":
            return self._json(200, self.app.save_settings(self._body()))
        raise AppError(404, "接口不存在")

    def _identity(self) -> RequestIdentity:
        visitor_id = self.headers.get("X-Visitor-ID", "")
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        trust_proxy = os.environ.get("TRUST_PROXY", "0") == "1"
        ip = forwarded if trust_proxy and forwarded else self.client_address[0]
        return self.app.identity(visitor_id, ip)

    def _admin_token(self) -> str | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        return cookie["admin_session"].value if "admin_session" in cookie else None

    def _require_admin(self) -> None:
        if not self.app.admin_authenticated(self._admin_token()):
            raise AppError(401, "请先登录管理员后台", "admin_login_required")

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise AppError(400, "请求长度无效") from exc
        if length > 2_500_000:
            raise AppError(413, "提交内容过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AppError(400, "请求内容不是有效JSON") from exc
        if not isinstance(value, dict):
            raise AppError(400, "请求内容无效")
        return value

    def _json(self, status: int, value: Any, cookie: str | None = None) -> None:
        payload = json_dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def _static(self, path: str) -> None:
        routes = {"/": "index.html", "/admin": "admin.html", "/admin/": "admin.html"}
        relative = routes.get(path, path.lstrip("/"))
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            raise AppError(404, "页面不存在")
        content = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".html", ".css", ".js"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(content)


class AppServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], app: CodePoolApp):
        super().__init__(address, AppRequestHandler)
        self.app = app


def main() -> None:
    parser = argparse.ArgumentParser(description="峡谷口令互助本地服务器")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()
    app = CodePoolApp(args.db)
    server = AppServer((args.host, args.port), app)
    print(f"峡谷口令互助已启动：http://{args.host}:{args.port}")
    if app.admin_password == "admin123":
        print("警告：当前使用开发密码 admin123，正式部署前请设置 ADMIN_PASSWORD。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
