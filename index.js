const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GEMINI_MODEL = "models/gemini-1.5-flash-8b";
const app = express();
app.use(bodyParser.json());

// Google OAuth2 client setup
const { client_id, client_secret, redirect_uris } =
  GOOGLE_CREDENTIALS.installed || GOOGLE_CREDENTIALS.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// Here you would normally set tokens from DB or env
// oAuth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKENS));

app.post("/", async (req, res) => {
  console.log("Incoming Telegram update:", req.body);

  try {
    const chatId = req.body?.message?.chat?.id;
    const userText = req.body?.message?.text;

    if (!chatId || !userText) {
      console.error("Invalid Telegram update format:", req.body);
      return res.sendStatus(200);
    }

    // Call Gemini
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: userText }] }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    console.log("Gemini response:", geminiData);

    let replyText = "Sorry, I couldn't get a reply from Gemini.";
    if (geminiData?.candidates?.[0]?.content?.parts?.[0]?.text) {
      replyText = geminiData.candidates[0].content.parts[0].text;
    }

    // Send message back to Telegram
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
  res.send("Bot is running with Gemini + Google Calendar integration coming soon");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
