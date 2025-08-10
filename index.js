const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const fs = require("fs");
const { google } = require("googleapis");

// ====== CONFIG ======
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "models/gemini-2.5-flash"; // Stable and latest

// ====== INIT ======
const app = express();
app.use(bodyParser.json());

// ====== GOOGLE CALENDAR SETUP ======
const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(GOOGLE_TOKEN);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ====== GOD PROMPT ======
const GOD_PROMPT = `
You are an AI assistant connected to a user's Google Calendar.
You can create, delete, update, and list events using natural language.

Respond with ONLY JSON if action is needed:
{
  "action": "create" | "delete" | "update" | "list",
  "event": {
    "summary": "Event title",
    "start": "YYYY-MM-DDTHH:mm:ss+05:30",
    "end": "YYYY-MM-DDTHH:mm:ss+05:30"
  }
}

Rules:
- If user asks to see upcoming events, use "list".
- If unsure of time or details, ask for clarification in plain text.
- Dates must be in ISO 8601 with timezone +05:30.
`;

// ====== GEMINI ASK ======
async function askGemini(userText) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: GOD_PROMPT + "\nUser: " + userText }] }]
      })
    }
  );
  return await response.json();
}

// ====== TELEGRAM WEBHOOK ======
app.post("/", async (req, res) => {
  console.log("Incoming Telegram update:", req.body);
  try {
    const chatId = req.body?.message?.chat?.id;
    const userText = req.body?.message?.text;
    if (!chatId || !userText) return res.sendStatus(200);

    const geminiData = await askGemini(userText);
    let aiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let replyText = "";

    // Try to parse JSON for action
    try {
      const actionObj = JSON.parse(aiText);
      replyText = await handleCalendarAction(actionObj);
    } catch {
      // Not JSON, just normal AI reply
      replyText = aiText || "Sorry, I couldn't understand that.";
    }

    // Send reply to Telegram
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

// ====== CALENDAR ACTIONS ======
async function handleCalendarAction(actionObj) {
  switch (actionObj.action) {
    case "create":
      await calendar.events.insert({
        calendarId: "primary",
        resource: {
          summary: actionObj.event.summary,
          start: { dateTime: actionObj.event.start },
          end: { dateTime: actionObj.event.end }
        }
      });
      return `✅ Event "${actionObj.event.summary}" created successfully.`;

    case "list":
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime"
      });
      if (!res.data.items.length) return "📅 You have no upcoming events.";
      return res.data.items.map(e => `${e.summary} - ${e.start.dateTime || e.start.date}`).join("\n");

    // delete/update would go here

    default:
      return "❓ I didn't understand the action.";
  }
}

app.get("/", (req, res) => res.send("Bot is running with Gemini + Google Calendar"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
