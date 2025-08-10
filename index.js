const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

// ==== ENV VARIABLES ====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "models/gemini-1.5-flash"; // Fast + good for NLP

// ==== GOOGLE AUTH ====
const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(GOOGLE_TOKEN);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ==== EXPRESS APP ====
const app = express();
app.use(bodyParser.json());

// ==== GEMINI QUERY ====
async function askGemini(userText) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `You are a Google Calendar assistant. 
Understand the user's request and return JSON in this format:
{
  "action": "getEvents" | "createEvent" | "updateEvent" | "deleteEvent",
  "title": "event title",
  "start": "YYYY-MM-DDTHH:MM:SS",
  "end": "YYYY-MM-DDTHH:MM:SS"
}
If times or titles are missing, infer them if possible. User said: ${userText}`
              }
            ]
          }
        ]
      })
    }
  );
  const data = await res.json();
  console.log("Gemini raw response:", JSON.stringify(data, null, 2));

  let parsed;
  try {
    parsed = JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (e) {
    console.error("Failed to parse Gemini JSON:", e);
  }
  return parsed;
}

// ==== CALENDAR ACTIONS ====
async function handleCalendarAction(actionData) {
  switch (actionData.action) {
    case "getEvents": {
      const events = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime"
      });
      if (!events.data.items.length) return "No upcoming events found.";
      return events.data.items
        .map(e => `${e.summary} at ${e.start.dateTime || e.start.date}`)
        .join("\n");
    }
    case "createEvent": {
      await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: actionData.title,
          start: { dateTime: actionData.start },
          end: { dateTime: actionData.end }
        }
      });
      return `Event "${actionData.title}" created for ${actionData.start}`;
    }
    case "updateEvent":
      return "Update event feature not implemented yet.";
    case "deleteEvent":
      return "Delete event feature not implemented yet.";
    default:
      return "I couldn't understand your request.";
  }
}

// ==== TELEGRAM WEBHOOK ====
app.post("/", async (req, res) => {
  console.log("Incoming Telegram update:", req.body);
  try {
    const chatId = req.body?.message?.chat?.id;
    const userText = req.body?.message?.text;

    if (!chatId || !userText) return res.sendStatus(200);

    const parsed = await askGemini(userText);
    let reply = "Sorry, I couldn't process that.";
    if (parsed) reply = await handleCalendarAction(parsed);

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
  } catch (err) {
    console.error("Error handling message:", err);
  }
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Telegram Google Calendar bot is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
