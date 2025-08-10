const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const GOOGLE_TOKEN = JSON.parse(process.env.GOOGLE_TOKEN);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const app = express();
app.use(bodyParser.json());

/**
 * Authorize Google Calendar client
 */
function getCalendarClient() {
  const { client_secret, client_id, redirect_uris } = GOOGLE_CREDENTIALS.installed || GOOGLE_CREDENTIALS.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(GOOGLE_TOKEN);
  return google.calendar({ version: "v3", auth: oAuth2Client });
}

/**
 * Ask Gemini for a natural language response
 */
async function askGemini(userText) {
  const GEMINI_MODEL = "gemini-2.5-flash";
  const godPrompt = `
You are a Google Calendar assistant connected to the user's calendar.
You can:
- Read, create, delete, and update events.
- Answer questions about upcoming or past events.
- Parse natural language like "Add meeting with John tomorrow at 3pm" or "Move my dentist appointment to Friday".
If the user wants to create or modify events, respond in JSON with this format ONLY:
{"action":"create","summary":"Meeting name","date":"YYYY-MM-DD","time":"HH:MM"}
{"action":"list"}
{"action":"delete","summary":"Meeting name"}
Otherwise, just answer normally.
`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: godPrompt }] },
          { parts: [{ text: userText }] }
        ]
      })
    }
  );

  const data = await res.json();
  console.log("Gemini raw:", data);

  if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text.trim();
  }
  return "Sorry, I couldn't get a reply from Gemini.";
}

/**
 * Handle AI + Google Calendar actions
 */
async function handleCalendarAction(chatId, aiResponse) {
  let parsed;
  try {
    parsed = JSON.parse(aiResponse);
  } catch {
    // Not JSON → Just reply as text
    return sendMessage(chatId, aiResponse);
  }

  const calendar = getCalendarClient();

  if (parsed.action === "list") {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults: 5,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = res.data.items;
    if (!events.length) return sendMessage(chatId, "No upcoming events found.");
    const list = events.map(e => `${e.summary} at ${e.start.dateTime || e.start.date}`).join("\n");
    return sendMessage(chatId, `Your upcoming events:\n${list}`);
  }

  if (parsed.action === "create") {
    const eventStart = `${parsed.date}T${parsed.time}:00`;
    const eventEnd = `${parsed.date}T${String(Number(parsed.time.split(":")[0]) + 1).padStart(2, "0")}:${parsed.time.split(":")[1]}:00`;
    await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: parsed.summary,
        start: { dateTime: eventStart, timeZone: "Asia/Kolkata" },
        end: { dateTime: eventEnd, timeZone: "Asia/Kolkata" },
      },
    });
    return sendMessage(chatId, `Event "${parsed.summary}" created on ${parsed.date} at ${parsed.time}`);
  }

  if (parsed.action === "delete") {
    const res = await calendar.events.list({
      calendarId: "primary",
      q: parsed.summary,
      singleEvents: true,
    });
    const event = res.data.items[0];
    if (!event) return sendMessage(chatId, `No event found with name "${parsed.summary}"`);
    await calendar.events.delete({ calendarId: "primary", eventId: event.id });
    return sendMessage(chatId, `Event "${parsed.summary}" deleted.`);
  }

  return sendMessage(chatId, aiResponse);
}

/**
 * Send message to Telegram
 */
async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/**
 * Webhook endpoint
 */
app.post("/", async (req, res) => {
  const chatId = req.body?.message?.chat?.id;
  const userText = req.body?.message?.text;
  if (!chatId || !userText) return res.sendStatus(200);

  try {
    const aiResponse = await askGemini(userText);
    await handleCalendarAction(chatId, aiResponse);
  } catch (err) {
    console.error("Error handling message:", err);
    await sendMessage(chatId, "Something went wrong.");
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Bot is running with Gemini + Google Calendar"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
