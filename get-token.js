const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = path.join(__dirname, "token.json");

// Load credentials.json
const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf-8"));
const { client_secret, client_id, redirect_uris } = credentials.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0] // Should be http://localhost:3000/oauth2callback
);

function startOAuthServer() {
  const express = require("express");
  const app = express();

  app.get("/oauth2callback", async (req, res) => {
    const code = req.query.code;
    if (!code) {
      return res.send("No code found in callback.");
    }

    try {
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log("✅ Token stored to", TOKEN_PATH);
      res.send("Authorization successful! You can close this window.");
      process.exit(0);
    } catch (err) {
      console.error("Error retrieving access token", err);
      res.send("Error retrieving access token.");
    }
  });

  app.listen(3000, () => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    console.log("Authorize this app by visiting:", authUrl);
  });
}

startOAuthServer();
