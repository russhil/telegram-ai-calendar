const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const GEMINI_MODEL = "models/gemini-2.5-flash";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const app = express();
app.use(bodyParser.json());

// Authorize Google Calendar
function authorize() {
  const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(GOOGLE_TOKEN);
  return oAuth2Client;
}

// Ask Gemini
async function askGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: prompt }] }
        ]
      })
    }
  );

  const data = await res.json();
  if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }
  console.error("Gemini error:", data);
  return null;
}

// List events
async function listEvents(auth) {
  const calendar = google.calendar({ version: "v3", auth });
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: "startTime",
  });

  if (!res.data.items.length) return "No upcoming events found.";
  return res.data.items
    .map((event) => {
      const start = event.start.dateTime || event.start.date;
      return `${event.summary} at ${start}`;
    })
    .join("\n");
}

// Create event
async function createEvent(auth, details) {
  const calendar = google.calendar({ version: "v3", auth });
  const event = {
    summary: details.summary,
    start: { dateTime: details.start, timeZone: "Asia/Kolkata" },
    end: { dateTime: details.end, timeZone: "Asia/Kolkata" }
  };

  try {
    const res = await calendar.events.insert({
      calendarId: "primary",
      resource: event
    });
    return `✅ Event "${res.data.summary}" created for ${res.data.start.dateTime}`;
  } catch (err) {
    console.error("Error creating event:", err);
    return "❌ Failed to create event.";
  }
}

// Handle Telegram messages
app.post("/", async (req, res) => {
  const chatId = req.body?.message?.chat?.id;
  const userText = req.body?.message?.text;

  if (!chatId || !userText) return res.sendStatus(200);

  let replyText = "";
  const auth = authorize();

  try {
    if (/^hi$|^hello$/i.test(userText)) {
      replyText = "Hi! I can manage your calendar. Try saying 'list my events' or 'create meeting with Alex tomorrow at 5pm'.";
    }
    else if (/list.*event/i.test(userText)) {
      replyText = await listEvents(auth);
    }
    else if (/create|add|schedule/i.test(userText)) {
      // Ask Gemini to extract details
      const geminiPrompt = `Extract calendar event details from this text and return ONLY valid JSON with keys: summary, start, end in ISO 8601 format. Text: "${userText}"`;
      const geminiOutput = await askGemini(geminiPrompt);
      try {
        const details = JSON.parse(geminiOutput);
        replyText = await createEvent(auth, details);
      } catch {
        replyText = "Couldn't parse event details.";
      }
    }
    else {
      replyText = await askGemini(`You are a helpful assistant. Reply to: "${userText}"`);
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
  res.send("Telegram AI Calendar Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
