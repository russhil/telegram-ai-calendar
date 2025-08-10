const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = path.join(__dirname, "token.json");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(content);
}

function loadSavedToken() {
  try {
    const content = fs.readFileSync(TOKEN_PATH, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
  console.log("Token saved to", TOKEN_PATH);
}

function authorize(callback) {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = loadSavedToken();
  if (!token) {
    console.log("No token found. Please run: node get-token.js");
    return null;
  }
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function addEvent(summary, startDateTime, endDateTime) {
  const auth = authorize();
  if (!auth) return "Authorization required. Please generate token.json";

  const calendar = google.calendar({ version: "v3", auth });
  const event = {
    summary,
    start: { dateTime: startDateTime, timeZone: "Asia/Kolkata" },
    end: { dateTime: endDateTime, timeZone: "Asia/Kolkata" },
  };

  try {
    await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });
    return `Event '${summary}' added to Google Calendar.`;
  } catch (err) {
    console.error("Error adding event:", err);
    return "Failed to add event.";
  }
}

module.exports = { addEvent };
