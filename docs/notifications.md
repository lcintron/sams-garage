# Notifications

SAM's Garage can send you **one report a day, and only when there is something to report**, to Slack, Discord,
Microsoft Teams or WhatsApp. Set it up in the app: open the menu (☰) and choose **Notifications** (`#/notify`).

A report has up to three parts, and you can switch each one off:

| Part | What is in it |
|---|---|
| **Starred updates** | Any change to a topic on your watchlist (status, dates, description, or no longer listed), whatever your keywords. |
| **New matches** | New topics that match your keywords, hashtags or chosen keyword profiles. |
| **Updated matches** | Matching topics whose status or content changed. |

A topic shows up once, in the first part that applies. Each part lists up to 15 topics, with "and N more" and a link to
the app for the rest. Every topic links to its page in the app, and every report ends with a link to the app.

Keywords match whole words and phrases in any case. A hyphen and a space count as the same, and a leading `#` is
ignored, so `#Counter-UAS` matches "counter UAS" and `uas` does not match "persuasive". These are the rules the app's
keyword profiles use. With no keywords or profiles, only starred topics are reported.

**One report a day per channel.** A report goes out at or after the time you choose (default 08:00, your local time),
and never twice on the same date. If the device was off at that time, the missed report is sent at the next check, even
before that day's time. Each report covers everything since the one before, so a missed or failed day loses nothing.
A channel that fails is tried once more at the next check, then again the next day. A day with nothing to report sends
nothing.

## Where it runs

| Where | When it runs | Limits |
|---|---|---|
| **Desktop app** (recommended) | It checks every 15 minutes, and when the computer wakes or unlocks. Turn on **Keep running in the tray** and **Start at login** in the tray icon's menu, and it keeps sending with its window closed. | The computer has to be on. Every platform works. Webhooks and keys are encrypted with the system keychain (DPAPI, Keychain, libsecret). |
| **GitHub Actions** | After each daily data refresh (06:15 UTC), with every device off. | You export your settings to a repository secret. The report covers that run's changes, and the time of day does not apply. Re-export after you change your settings or watchlist. |
| **Browser** (best effort) | When you open the app or bring it back to the front. An installed Chromium app with Periodic Background Sync also wakes about twice a day, while the browser is running. | A browser never runs when it is fully closed. Periodic Background Sync exists only in Chromium browsers (Chrome, Edge) for installed apps, and only once the browser allows it. Teams and the WhatsApp Cloud API cannot be sent from a browser. |

Set up each channel in one place only. A channel set up both in the desktop app and in GitHub Actions gets two
reports. You can also have each report shown as a notification on the device that sends it, and clicking it opens the
report in the app.

**Start at login**, from the tray menu:

| System | What happens |
|---|---|
| Windows | The app starts with its window hidden (`--hidden`), in the tray. |
| macOS | macOS ignores start-up arguments, and "open hidden" since macOS 13. The app notices it was opened at login and starts hidden in the menu-bar icon the same way. |
| Linux | Electron has no login items. Add the app to your desktop's autostart, with `--hidden` to start it hidden. |

With **Keep running in the tray** on, closing the window on Windows and Linux hides it, and the reports keep their
schedule. On macOS the app keeps its usual behaviour: it stays in the Dock when its window closes, and has the
menu-bar icon too.

## Setting up a channel

Add a channel in **Notifications → Channels**, then use **Send test** to check it before the first report.

**Slack**
1. Go to <https://api.slack.com/apps>, choose **Create New App → From scratch**, and pick your workspace.
2. Under **Incoming Webhooks**, switch them on, then **Add New Webhook to Workspace** and choose the channel.
3. Copy the webhook URL (`https://hooks.slack.com/services/…`) into a new Slack channel in the app.

**Discord**
1. In the Discord channel, open **Edit Channel → Integrations → Webhooks → New Webhook**.
2. Name it if you like (reports show as "SAM's Garage" anyway), then **Copy Webhook URL**.
3. Paste the URL (`https://discord.com/api/webhooks/…`) into a new Discord channel in the app.

**Microsoft Teams** (desktop app or GitHub Actions)
1. In Teams, open the channel's **⋯** menu → **Workflows**, and pick the template **Post to a channel when a webhook
   request is received**.
2. Choose the team and channel, then finish. Teams shows the workflow's URL; copy it.
3. In the desktop app, paste it into a new Microsoft Teams channel. Office 365 connector URLs
   (`…webhook.office.com…`) are retired and are refused.
4. In the web app, add the Teams channel with only its name. A browser cannot send to Teams, so it never stores the
   URL. You paste the URL under **Export for GitHub Actions**, and it is used for that export only.

**WhatsApp with CallMeBot** (free, for messages to your own number)
1. Follow the steps on [CallMeBot's WhatsApp page](https://www.callmebot.com/blog/free-api-whatsapp-messages/): add
   their number to your contacts and send it the activation message. It replies with your API key.
2. In the app, add a **WhatsApp (CallMeBot)** channel with your number (with country code, such as `+15551234567`)
   and the key.
3. Reports come as plain text of up to about 1,500 characters, ending with a link to the app.

**WhatsApp with the Cloud API** (Meta, business accounts; desktop app or GitHub Actions)
1. In [Meta for Developers](https://developers.facebook.com/), create an app with the WhatsApp product and add a phone
   number. Note its **Phone number ID**, and create a permanent access token (a system user token with
   `whatsapp_business_messaging`).
2. WhatsApp only lets businesses start a conversation with an **approved message template**. In WhatsApp Manager,
   create a template (category Utility) whose body has **exactly one variable**, `{{1}}`. For example:
   `Your SAM's Garage report: {{1}}`. Wait for it to be approved.
3. In the app, add a **WhatsApp (Cloud API)** channel with the phone number ID, the token, the recipient's number, the
   template's name and its language code (such as `en_US`). The app fills `{{1}}` with a one-line summary of up to
   1,000 characters, ending with the link.
4. In the web app, the channel keeps only the template's name and language. The phone number ID, the token and the
   recipient are typed under **Export for GitHub Actions**, for that export only, as for Teams.

## GitHub Actions: the SG_NOTIFY_CONFIG secret

1. In the app, open **Notifications** and set it up (channels, keywords, triggers, the daily report switched on).
2. Choose **Copy settings for GitHub Actions**. This copies your settings, your watchlist and your own keyword profiles
   as JSON, **including every webhook URL, key and token**. In the web app, first fill in the Teams and WhatsApp Cloud
   API fields it asks for there. They go into this export only and are not saved.
3. In the GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret**. Name it
   `SG_NOTIFY_CONFIG`, paste the JSON and save.

The scheduled run of [`scrape.yml`](../.github/workflows/scrape.yml) then runs `node scripts/notify.mjs` in its own job,
once the site has been deployed with that data, so the links in the report open on it. It reports the events of that
run and masks every secret in the log. A run you start by hand sends only if
you tick **notify**, so a manual refresh never repeats the day's report. A channel that cannot be reached is a warning,
never a failed workflow. With no secret set, the step does nothing.

## Privacy

Webhook URLs, keys, tokens and phone numbers stay on your device:
- The desktop app encrypts them on disk with the system keychain. Where there is none, it stores them unencrypted and
  says so.
- The web app keeps in IndexedDB only those for the channels a browser can send to (Slack, Discord, CallMeBot). Teams
  and WhatsApp Cloud API secrets are never stored in the browser; they are typed at export time.
- The only other place they go is the repository secret, if you export them there.

They never appear in the app's own URLs or in logs, and the GitHub Actions step masks them. The secret fields are
marked so that browsers and password managers do not offer to save them.

**Shared address.** While the web app lives at `lcintron.github.io/sams-garage/`, it shares its browser storage origin
(`lcintron.github.io`) with every other GitHub Pages site of that account. Any of those sites could read what this one
keeps in the browser, webhooks included. The app warns about this when you add a channel there. Until it moves to its
own domain, prefer the desktop app or GitHub Actions for webhooks and keys.

Anyone who has a webhook URL can post to that channel, so treat the exported JSON like a password. **Settings → Data
and storage → Clear local data** deletes all of it from the device. Reports go straight
from your device, or from GitHub Actions, to the platform you chose. No SAM's Garage server is involved.
