const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "gemini-2.5-flash"; // ✅ Correct path
const app = express();
app.use(bodyParser.json());

// Google Calendar setup
const { client_id, client_secret, redirect_uris } = GOOGLE_CREDENTIALS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(GOOGLE_TOKEN);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// Ask Gemini with god prompt
async function askGemini(userText) {
  const godPrompt = `
You are CalendarAI, a powerful assistant that controls Google Calendar for the user.
You can:
1. List upcoming events.
2. Create new events.
3. Delete or reschedule events.

Rules:
- Always reply in pure JSON with this structure:
  { "action": "list" }  // to list events
  { "action": "create", "title": "Event name", "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS" }
  { "action": "delete", "title": "Event name" }
- Do not include extra text or explanations.
- If the request is unclear, infer the most likely intent.
`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${godPrompt}\nUser: ${userText}` }] }]
      })
    }
  );

  const data = await res.json();
  console.log("Gemini raw:", data);

  try {
    return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini JSON:", e);
    return {};
  }
}

// Calendar actions
async function listEvents() {
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: "startTime"
  });

  if (!res.data.items.length) return "No upcoming events.";
  return res.data.items.map(ev => `${ev.summary} at ${ev.start.dateTime || ev.start.date}`).join("\n");
}

async function createEvent(title, start, end) {
  await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: title,
      start: { dateTime: start, timeZone: "Asia/Kolkata" },
      end: { dateTime: end, timeZone: "Asia/Kolkata" }
    }
  });
  return `Event "${title}" created from ${start} to ${end}.`;
}

async function deleteEvent(title) {
  const res = await calendar.events.list({ calendarId: "primary", q: title });
  if (!res.data.items.length) return `No event found with title "${title}".`;

  await calendar.events.delete({
    calendarId: "primary",
    eventId: res.data.items[0].id
  });

  return `Event "${title}" deleted.`;
}

// Telegram webhook
app.post("/", async (req, res) => {
  console.log("Incoming Telegram update:", req.body);

  try {
    const chatId = req.body?.message?.chat?.id;
    const userText = req.body?.message?.text;
    if (!chatId || !userText) return res.sendStatus(200);

    const parsed = await askGemini(userText);
    let replyText = "Sorry, I couldn't process that request.";

    if (parsed.action === "list") {
      replyText = await listEvents();
    } else if (parsed.action === "create" && parsed.title && parsed.start && parsed.end) {
      replyText = await createEvent(parsed.title, parsed.start, parsed.end);
    } else if (parsed.action === "delete" && parsed.title) {
      replyText = await deleteEvent(parsed.title);
    }

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: replyText })
    });

  } catch (err) {
    console.error("Error handling message:", err);
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running with Gemini AI + Google Calendar");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is listening on port ${PORT}`));
