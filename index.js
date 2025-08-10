const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

// ===== Environment Variables =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "gemini-2.5-flash";

const app = express();
app.use(bodyParser.json());

// ===== Google Calendar Setup =====
const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(GOOGLE_TOKEN);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ===== Gemini AI Call =====
async function askGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      })
    }
  );

  const data = await res.json();
  console.log("Gemini raw:", data);

  if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }
  return "Sorry, I couldn't get a reply from Gemini.";
}

// ===== Handle Telegram Messages =====
app.post("/", async (req, res) => {
  console.log("Incoming Telegram update:", req.body);

  try {
    const chatId = req.body?.message?.chat?.id;
    const userText = req.body?.message?.text;

    if (!chatId || !userText) {
      return res.sendStatus(200);
    }

    let replyText = "";

    // Calendar commands
    if (/create event/i.test(userText)) {
      const event = {
        summary: "Test Event from Telegram Bot",
        start: { dateTime: new Date().toISOString(), timeZone: "Asia/Kolkata" },
        end: {
          dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          timeZone: "Asia/Kolkata"
        }
      };
      await calendar.events.insert({ calendarId: "primary", resource: event });
      replyText = "✅ Event created successfully in your Google Calendar!";
    } else if (/upcoming events/i.test(userText)) {
      const eventsRes = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime"
      });
      const events = eventsRes.data.items;
      if (events.length) {
        replyText = "📅 Upcoming events:\n" + events.map(e => `- ${e.summary}`).join("\n");
      } else {
        replyText = "No upcoming events found.";
      }
    } else {
      // Fallback to Gemini
      replyText = await askGemini(userText);
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

// ===== Root Endpoint =====
app.get("/", (req, res) => {
  res.send("Bot is running with Gemini + Google Calendar API");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
