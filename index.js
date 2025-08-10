const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

// ====== ENV VARS ======
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

// ====== TELEGRAM CONFIG ======
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "models/gemini-2.5-flash";

const app = express();
app.use(bodyParser.json());

// ====== GOOGLE CALENDAR AUTH ======
const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(GOOGLE_TOKEN);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ====== SYSTEM / GOD PROMPT ======
const SYSTEM_PROMPT = `
You are an AI assistant connected to the user's personal Google Calendar.
You can:
1. List upcoming events.
2. Create new events.
3. Reschedule or delete events (future expansion).
Always output JSON in the following format:
{
  "action": "listEvents" | "createEvent" | "none",
  "summary": "Only for createEvent",
  "start": "YYYY-MM-DDTHH:MM:SS+05:30",
  "end": "YYYY-MM-DDTHH:MM:SS+05:30"
}
If no calendar action is needed, return {"action":"none"} and then answer as a normal chatbot.
Never mention that you are returning JSON.
`;

// ====== Gemini API Call ======
async function askGemini(userText) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
          { role: "user", parts: [{ text: userText }] }
        ]
      })
    }
  );

  const data = await res.json();
  console.log("Gemini raw:", JSON.stringify(data, null, 2));

  try {
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return JSON.parse(text); // Parse as JSON
  } catch {
    return { action: "none", reply: "Sorry, I couldn't process that request." };
  }
}

// ====== Google Calendar Functions ======
async function listEvents() {
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    maxResults: 5,
    singleEvents: true,
    orderBy: "startTime",
  });
  if (!res.data.items.length) return "You have no upcoming events.";
  return res.data.items
    .map(e => `${e.summary} at ${e.start.dateTime || e.start.date}`)
    .join("\n");
}

async function createEvent(summary, start, end) {
  const event = {
    summary,
    start: { dateTime: start, timeZone: "Asia/Kolkata" },
    end: { dateTime: end, timeZone: "Asia/Kolkata" }
  };
  await calendar.events.insert({ calendarId: "primary", resource: event });
  return `Event "${summary}" created for ${start}`;
}

// ====== TELEGRAM HANDLER ======
app.post("/", async (req, res) => {
  const chatId = req.body?.message?.chat?.id;
  const userText = req.body?.message?.text;

  if (!chatId || !userText) return res.sendStatus(200);

  try {
    const aiResponse = await askGemini(userText);
    let reply;

    if (aiResponse.action === "listEvents") {
      reply = await listEvents();
    } else if (aiResponse.action === "createEvent") {
      reply = await createEvent(aiResponse.summary, aiResponse.start, aiResponse.end);
    } else {
      reply = aiResponse.reply || "I’m not sure what you mean.";
    }

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
  res.send("Telegram AI Calendar Bot is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
