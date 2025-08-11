import os
import json
import logging
from datetime import datetime, timedelta
import re
import requests
import pytz
from dateutil import parser as dateparser

from dotenv import load_dotenv
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, ContextTypes, filters

from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

# -----------------------------
# Load env
# -----------------------------
load_dotenv()

def safe_json_load(val):
    """Load JSON from env var string safely."""
    if not val:
        return None
    try:
        return json.loads(val)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON in environment variable: {e}")

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
BOT_TZ = os.getenv("BOT_TZ", "Asia/Kolkata")
GOOGLE_CREDENTIALS = safe_json_load(os.getenv("GOOGLE_CREDENTIALS"))
GOOGLE_TOKEN = safe_json_load(os.getenv("GOOGLE_TOKEN"))

if not TELEGRAM_TOKEN:
    raise RuntimeError("Missing TELEGRAM_TOKEN in .env")
if not GEMINI_API_KEY:
    raise RuntimeError("Missing GEMINI_API_KEY in .env")
if not GOOGLE_CREDENTIALS or not GOOGLE_TOKEN:
    raise RuntimeError("Missing Google API credentials in .env")

# logging
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bot")

# -----------------------------
# Google Calendar client
# -----------------------------
def build_calendar():
    web = GOOGLE_CREDENTIALS.get("web", {})
    creds = Credentials(
        token=GOOGLE_TOKEN.get("access_token"),
        refresh_token=GOOGLE_TOKEN.get("refresh_token"),
        token_uri=web.get("token_uri"),
        client_id=web.get("client_id"),
        client_secret=web.get("client_secret"),
        scopes=[GOOGLE_TOKEN.get("scope", "https://www.googleapis.com/auth/calendar")]
    )
    return build("calendar", "v3", credentials=creds)

calendar = build_calendar()

# -----------------------------
# Time helpers
# -----------------------------
def now_in_tz(tz_name):
    return datetime.now(pytz.timezone(tz_name))

def to_iso(dt):
    if dt.tzinfo is None:
        dt = pytz.timezone(BOT_TZ).localize(dt)
    return dt.isoformat(timespec="seconds")

def ensure_iso_with_tz(s, tz_name):
    tz = pytz.timezone(tz_name)
    dt = dateparser.parse(s)
    if dt.tzinfo is None:
        dt = tz.localize(dt)
    return to_iso(dt)

# -----------------------------
# Gemini parsing
# -----------------------------
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"

SYSTEM_INSTRUCTION = """
You are a scheduling tool. Convert natural language into JSON for Google Calendar.
Allowed intents: create, list, delete.
Always return only JSON, no markdown.
"""

def gemini_parse_command(user_text, tz_name):
    now_iso = to_iso(now_in_tz(tz_name))
    body = {
        "systemInstruction": {
            "role": "system",
            "parts": [{"text": SYSTEM_INSTRUCTION}]
        },
        "generationConfig": {
            "temperature": 0,
            "candidateCount": 1,
            "responseMimeType": "application/json"
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"NOW_TZ: {tz_name}\nNOW_ISO: {now_iso}\nUser request:\n{user_text}"}]
            }
        ]
    }
    r = requests.post(GEMINI_URL, json=body)
    r.raise_for_status()
    payload = r.json()
    log.info("Gemini raw: %s", payload)

    cand = (payload.get("candidates") or [{}])[0]
    parts = cand.get("content", {}).get("parts", [])
    if parts and isinstance(parts[0], dict):
        text = parts[0].get("text", "").strip()
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            text = m.group(0)
        return json.loads(text)
    return None

# -----------------------------
# Calendar actions
# -----------------------------
def cal_create(summary, start_iso, end_iso, tz_name):
    event = {
        "summary": summary,
        "start": {"dateTime": start_iso, "timeZone": tz_name},
        "end": {"dateTime": end_iso, "timeZone": tz_name},
    }
    ins = calendar.events().insert(calendarId="primary", body=event).execute()
    return f"✅ Created: {summary}\n{start_iso} → {end_iso}\n{ins.get('htmlLink')}"

def cal_list(starting_from_iso, max_results, tz_name):
    if not starting_from_iso:
        starting_from_iso = to_iso(now_in_tz(tz_name))
    resp = calendar.events().list(
        calendarId="primary",
        timeMin=dateparser.parse(starting_from_iso).isoformat(),
        maxResults=max_results or 5,
        singleEvents=True,
        orderBy="startTime",
    ).execute()
    items = resp.get("items", [])
    if not items:
        return "No upcoming events."
    return "📅 Upcoming events:\n" + "\n".join(
        f"• {ev.get('summary')} — {ev.get('start', {}).get('dateTime')}" for ev in items
    )

def cal_delete(summary, ref_start_iso, tz_name):
    search_from = ref_start_iso or to_iso(now_in_tz(tz_name))
    resp = calendar.events().list(
        calendarId="primary",
        timeMin=dateparser.parse(search_from).isoformat(),
        maxResults=10,
        singleEvents=True,
        orderBy="startTime",
        q=summary
    ).execute()
    items = resp.get("items", [])
    if items:
        event_id = items[0]["id"]
        calendar.events().delete(calendarId="primary", eventId=event_id).execute()
        return f"🗑️ Deleted: {items[0].get('summary')}"
    return "No matching event found."

# -----------------------------
# Telegram handlers
# -----------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Hi! Send me event commands in natural language.")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    parsed = gemini_parse_command(update.message.text, BOT_TZ)
    if not parsed:
        await update.message.reply_text("❌ Couldn't understand the event details.")
        return

    intent = parsed.get("intent")
    summary = parsed.get("summary")
    start_iso = parsed.get("start")
    end_iso = parsed.get("end")
    if start_iso:
        start_iso = ensure_iso_with_tz(start_iso, BOT_TZ)
    if end_iso:
        end_iso = ensure_iso_with_tz(end_iso, BOT_TZ)

    if intent == "create":
        msg = cal_create(summary, start_iso, end_iso, BOT_TZ)
    elif intent == "list":
        msg = cal_list(parsed.get("starting_from"), parsed.get("max_results"), BOT_TZ)
    elif intent == "delete":
        msg = cal_delete(summary, start_iso, BOT_TZ)
    else:
        msg = "❌ Unsupported command."
    await update.message.reply_text(msg)

# -----------------------------
# Main
# -----------------------------
def main():
    app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.run_polling()

if __name__ == "__main__":
    main()
