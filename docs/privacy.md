---
title: Privacy Policy
---

# Privacy Policy — Desktop Widgets

_Last updated: 30 August 2026_

Desktop Widgets is an open-source application that runs entirely on your own
computer. It is not a hosted service, and it has no servers.

## What the app accesses

If you connect a Google account, the app requests a single, read-only scope:

- `https://www.googleapis.com/auth/gmail.readonly` — used solely to list recent
  messages and display their sender, subject and snippet in the email widget.

This scope cannot send, modify, or delete mail.

If you connect calendars, the app fetches iCalendar (`.ics`) feeds from URLs
that you supply yourself.

## What the app does with your data

- **Everything stays on your device.** Message and calendar data is read
  directly from Google to your computer and rendered on screen.
- **Nothing is transmitted to the developer.** There is no backend, no
  analytics, no telemetry, and no third-party service of any kind.
- **Nothing is shared or sold.** No data leaves your machine.
- **Caching is local only.** Calendar feeds are cached in your operating
  system's application-data folder so the widgets still render while offline.
- **Credentials are stored locally.** Your OAuth refresh token is stored using
  your operating system's encrypted credential storage. Client configuration is
  kept in a local file that is excluded from version control.

## Retention and deletion

Because all data is local, you remove it by deleting it:

- Delete the application-data folder to remove cached calendar and token data.
- Revoke the app's access at any time from
  [Google Account permissions](https://myaccount.google.com/permissions).
- Uninstalling the app removes everything else.

## Google API Services User Data Policy

Desktop Widgets' use and transfer of information received from Google APIs
adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Changes

Any changes to this policy will be published on this page with an updated date.

## Contact

Questions can be raised as an issue on the project's GitHub repository.
