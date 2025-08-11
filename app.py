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
# Load Environment
# -----------------------------
load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
BOT_TZ = os.getenv("BOT_TZ", "Asia/Kolkata")
GOOGLE_CREDENTIALS = json.loads(os.getenv("GOOGLE_CREDENTIALS"))
GOOGLE_TOKEN = json.loads(os.getenv("GOOGLE_TOKEN"))

logging.basicConfig(format="%(asctime)s %(levelname)s: %(message)s", level=logging.INFO)
log = logging.getLogger("calbot")

# -----------------------------
# Google Calendar Client
# -----------------------------
def build_calendar():
    creds = Credentials(
        token=GOOGLE_TOKEN["access_token"],
        refresh_token=GOOGLE_TOKEN["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CREDENTIALS["web"]["client_id"],
        client_secret=GOOGLE_CREDENTIALS["web"]["client_secret"],
        scopes=["https://www.googleapis.com/auth/calendar"],
    )
    return build("calendar", "v3", credentials=creds)

calendar = build_calendar()

# -----------------------------
# Time Helpers
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
# Gemini Model Config
# -----------------------------
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"

SYSTEM_INSTRUCTION = """
You are a powerful and efficient calendar assistant. Your job is to understand a user's natural language request and output a JSON object that specifies exactly one Google Calendar action.

---
Core Instructions & Tool Guide
---
1. Default calendar: Always use "CalBotCal" unless the user specifies another.
2. If "CalBotCal" does not exist, include a step to create it before performing other actions.
3. Allowed intents:
   - "create"
   - "list"
   - "delete"
   - "modify"
   - "list_calendars"
   - "create_calendar"
   - "delete_calendar"
4. Ask user for confirmation before `delete_calendar`.

---
JSON Rules
---
- Always return ONLY valid JSON (no markdown, no code fences, no commentary).
- Dates/times must be full ISO strings with timezone offset.
- If only date: default 09:00–10:00 in BOT_TZ.
- If only time: assume today.
- For list: include optional `max_results` (default 5) and `starting_from` (default now).
- For delete: match event name as closely as possible.
- Always include `"calendar_id"`.

Example:
{
  "intent": "create",
  "calendar_id": "calbotcal_id_here",
  "summary": "Team Meeting",
  "start": "2025-08-11T09:00:00+05:30",
  "end": "2025-08-11T10:00:00+05:30"
}
"""

# -----------------------------
# Gemini Parsing
# -----------------------------
def gemini_parse_command(user_text, tz_name):
    now_iso = to_iso(now_in_tz(tz_name))
    body = {
        "systemInstruction": {"role": "system", "parts": [{"text": SYSTEM_INSTRUCTION}]},
        "generationConfig": {
            "temperature": 0,
            "topK": 32,
            "topP": 0.9,
            "candidateCount": 1,
            "responseMimeType": "application/json",
        },
        "contents": [{
            "role": "user",
            "parts": [{
                "text": f"NOW_TZ: {tz_name}\nNOW_ISO: {now_iso}\nUser request: {user_text}"
            }]
        }]
    }

    try:
        r = requests.post(GEMINI_URL, json=body, timeout=20)
        r.raise_for_status()
        payload = r.json()
        log.info("Gemini raw: %s", payload)

        # Extract text safely
        text = None
        cand = (payload.get("candidates") or [{}])[0]
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        if parts and isinstance(parts[0], dict):
            text = parts[0].get("text", "")

        if not text:
            return None

        text = text.strip()
        # Extract JSON block if model wraps in text
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if m:
            text = m.group(0)

        data = json.loads(text)

        # Auto-guess intent if missing
        if "intent" not in data:
            lowered = user_text.lower()
            if any(k in lowered for k in ["add", "schedule", "create", "book"]):
                data["intent"] = "create"
            elif any(k in lowered for k in ["delete", "remove", "cancel"]):
                data["intent"] = "delete"
            elif any(k in lowered for k in ["show", "list", "what's", "upcoming"]):
                data["intent"] = "list"

        return data
    except Exception as e:
        log.error("Gemini parse error: %s", e)
        return None

# -----------------------------
# Calendar Actions
# -----------------------------
def cal_create(summary, start_iso, end_iso, tz_name):
    event = {
        "summary": summary,
        "start": {"dateTime": start_iso, "timeZone": tz_name},
        "end": {"dateTime": end_iso, "timeZone": tz_name},
    }
    ins = calendar.events().insert(calendarId="primary", body=event).execute()
    return f"✅ Created: {summary} ({start_iso} → {end_iso})"

def cal_list(starting_from_iso, max_results, tz_name):
    if not starting_from_iso:
        starting_from_iso = to_iso(now_in_tz(tz_name))
    if not max_results:
        max_results = 5
    resp = calendar.events().list(
        calendarId="primary",
        timeMin=dateparser.parse(starting_from_iso).isoformat(),
        maxResults=max_results,
        singleEvents=True,
        orderBy="startTime",
    ).execute()
    items = resp.get("items", [])
    if not items:
        return "No upcoming events found."
    return "📅 " + "\n".join(f"• {i['summary']} — {i['start'].get('dateTime', i['start'].get('date'))}" for i in items)

def cal_delete(summary, ref_start_iso, tz_name):
    search_from = dateparser.parse(ref_start_iso).isoformat() if ref_start_iso else to_iso(now_in_tz(tz_name))
    resp = calendar.events().list(calendarId="primary", timeMin=search_from, maxResults=10, singleEvents=True, orderBy="startTime", q=summary).execute()
    items = resp.get("items", [])
    if items:
        event_id = items[0]["id"]
        calendar.events().delete(calendarId="primary", eventId=event_id).execute()
        return f"🗑️ Deleted: {summary}"
    return "Couldn't find an event to delete."

# -----------------------------
# Telegram Handlers
# -----------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Hi! I can manage your Google Calendar. Try: 'remind me to buy milk tomorrow at 10am'.")

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_text = (update.message.text or "").strip()
    parsed = gemini_parse_command(user_text, BOT_TZ)
    if not parsed:
        await update.message.reply_text("Sorry, I couldn't understand that.")
        return

    intent = parsed.get("intent")
    summary = parsed.get("summary", "Untitled Event")
    start_iso = parsed.get("start")
    end_iso = parsed.get("end")
    starting_from = parsed.get("starting_from")
    max_results = parsed.get("max_results")

    if start_iso:
        start_iso = ensure_iso_with_tz(start_iso, BOT_TZ)
    if end_iso:
        end_iso = ensure_iso_with_tz(end_iso, BOT_TZ)

    if intent == "list":
        msg = cal_list(starting_from, max_results, BOT_TZ)
    elif intent == "create":
        if not start_iso:
            start_iso = to_iso(now_in_tz(BOT_TZ).replace(hour=9, minute=0))
        if not end_iso:
            end_iso = to_iso(dateparser.parse(start_iso) + timedelta(hours=1))
        msg = cal_create(summary, start_iso, end_iso, BOT_TZ)
    elif intent == "delete":
        msg = cal_delete(summary, start_iso, BOT_TZ)
    else:
        msg = "Sorry, I couldn't process that request."

    await update.message.reply_text(msg)

# -----------------------------
# Main
# -----------------------------
def main():
    app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    log.info("Bot started.")
    app.run_polling()

if __name__ == "__main__":
    main()
