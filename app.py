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
You are a deterministic natural language to structured command translator for Google Calendar.
You MUST always return ONLY a single valid JSON object, never text, explanations, or code fences.

Output format (strict):
{
  "intent": "create" | "list" | "delete",
  "summary": "string (for create/delete)",
  "start": "ISO 8601 datetime with offset",
  "end": "ISO 8601 datetime with offset",
  "starting_from": "ISO 8601 datetime with offset (optional, list intent only)",
  "max_results": integer (optional, list intent only)
}

Rules:
1. Infer the intent from the user request even if they don’t explicitly say “create” or “list”.
2. If the request is about adding, scheduling, or planning — intent = "create".
3. If the request is about checking, showing, or viewing — intent = "list".
4. If the request is about removing, cancelling, or deleting — intent = "delete".
5. Resolve relative times (“tomorrow”, “next Monday”, “tonight”) to the correct ISO 8601 in NOW_TZ.
6. If only a date is given, default start time = 09:00, end time = 10:00 in NOW_TZ.
7. If only a time is given, assume today in NOW_TZ.
8. If deleting and no time is provided, delete the nearest match to NOW.
9. Strip emojis from the summary.
10. Do not ask questions — make reasonable assumptions.
"""

# -----------------------------
# Gemini Parsing
# -----------------------------
def gemini_parse_command(user_text: str, tz_name: str) -> dict | None:
    now_local = now_in_tz(tz_name)
    now_iso = to_iso(now_local)

    body = {
        "systemInstruction": {
            "role": "system",
            "parts": [{"text": SYSTEM_INSTRUCTION}]
        },
        "generationConfig": {
            "temperature": 0,
            "topK": 1,
            "topP": 0,
            "candidateCount": 1,
            "responseMimeType": "application/json"
        },
        "contents": [
            {
                "role": "user",
                "parts": [{
                    "text": (
                        f"NOW_TZ: {tz_name}\n"
                        f"NOW_ISO: {now_iso}\n"
                        f"User request: {user_text}"
                    )
                }]
            }
        ]
    }

    try:
        r = requests.post(GEMINI_URL, json=body, timeout=20)
        r.raise_for_status()
        payload = r.json()
        log.info("Gemini raw: %s", payload)

        text = None
        cand = (payload.get("candidates") or [{}])[0]
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        if parts and isinstance(parts[0], dict):
            text = parts[0].get("text")

        if not text:
            return None

        text = text.strip()
        m = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if m:
            text = m.group(0)

        return json.loads(text)
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
