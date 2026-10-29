# GatherOS Privacy Policy

_Last updated: October 29, 2026_

GatherOS is a local-first desktop app for saving, browsing, and organizing visual references. Your library lives on your Mac. This page explains what else leaves the machine: account sign-in, subscription checks, optional AI indexing, and an optional inbox you turn on yourself.

If anything below is unclear, email us at [hey@gatheros.co](mailto:hey@gatheros.co).

---

## What we don't do

- We do not show ads or share data with advertisers.
- We do not track your usage, capture analytics, or report telemetry.
- We do not upload your library folder. Saves you make in the app stay on disk unless you turn the inbox on, and even then only the items an assistant sends are stored on the server, for a limited time.

You can use GatherOS without an account for the local library. Sign-in is required for subscription features, AI indexing, and the inbox.

## Where your library lives

Every save, collection, tag, note, and thumbnail you create in the app is stored on your computer in macOS's standard application data directory:

```
~/Library/Application Support/GatherOS/
```

That folder is the library. GatherOS does not upload it. You can browse it, back it up, or delete it in Finder. **Erase library** in Settings removes the local library. **Export library as zip** writes a portable copy you can move to another machine.

## Account and sign-in

When you sign in, GatherOS emails you a magic link. The server stores your email address, a session for each signed-in device, and your subscription status so the app can tell a trial from a paid plan. Magic-link email is sent through [Resend](https://resend.com/legal/privacy-policy). Subscription state is mirrored from [Lemon Squeezy](https://www.lemonsqueezy.com/privacy) when billing is configured.

The session token stays on your Mac (encrypted with the system keychain when the OS allows it). Sign out in Settings to revoke that session.

## AI features

Auto-titles, visual search, auto-tagging, and image prompts run through a GatherOS server that holds the OpenAI credential. You do not paste an OpenAI API key.

When those features are on and you are signed in with an active subscription, the app sends image data and short text to the server, which forwards them to OpenAI. OpenAI handles that data under their own [terms of use](https://openai.com/policies/terms-of-use) and [privacy policy](https://openai.com/policies/privacy-policy). Leave the AI features off in **Settings → AI usage** and those calls are not made.

Usage is counted per account so a monthly cap can apply. That count is tokens and request totals, not the contents of your library.

## Inbox (optional, off by default)

Inbox lets an assistant you trust add inspiration to your library. It is off until you turn it on in **Settings → Inbox**.

**What is stored.** Items posted with a token you create: an image (or a page URL), a title, a short note about why it’s good, tags, a source name, and a source URL. The server also stores which token created the item, a content hash of the original image bytes, and the collection or board id the assistant picked. It does not receive the rest of your library.

**Where.** Metadata is in Cloudflare D1, scoped to your account. Image bytes are in Cloudflare R2 under a per-account key (`users/<your id>/inbox/...`). Cloudflare’s privacy policy covers that infrastructure.

**Who can write.** Only someone holding an inbox token you created in Settings. The raw token is shown once and stored only as a hash. It can add items, list collection names and recent inbox items, read the ratings you gave inbox items, and ask the app to file them. It cannot read your saves, download your library, use AI, or change billing. Revoke it in Settings. Revoking also deletes that token’s items that have not been imported yet.

**How it reaches your Mac.** The app pulls pending items with your sign-in session, on launch, on a timer, when the window is focused, and when you choose **Pull now**. Each image is saved through the same local path as any other save, including a thumbnail and palette, and AI indexing if that is already on. The app then tells the server the item was delivered.

**Retention.** Image bytes are deleted 7 days after the app acknowledges delivery (imported, duplicate, or failed). Items still pending after 30 days are deleted, including their bytes. You can also delete a pending item by revoking the token that created it.

**Dedupe.** The same original bytes are not queued twice for one account. The hash is of those original bytes, not of the smaller file the app may store locally.

**Ratings and filing.** If you like or dislike an inbox save, the app sends that rating, the item's id, and when you rated it to your own GatherOS server (the one in **Settings → API server**), with your sign-in session. Nothing about saves you made yourself is sent. A token you created can read those ratings back with the item's title, note, tags, and source, so the assistant can learn what you like. It can also ask the app to move a rated inbox item into a collection, or create a collection by name. The server stores that request and whether the app applied it. The app makes the move on your Mac, never deletes a save, and only touches saves that came from the inbox. Ratings and filing requests stay until you delete your account.

## Auto-updates

GatherOS checks for new releases via GitHub Releases. The check is an HTTPS request to `github.com` for a metadata file (`latest-mac.yml`) and, when an update is available, the downloaded build itself. GitHub may log standard HTTP request information (IP address, user agent) the same way it does for any download — see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). GatherOS doesn't add anything to those requests beyond the version metadata electron-updater needs to do its job.

## Image storage

When you save an image in the app, GatherOS writes the file and a thumbnail into the application data directory above. Files you drop in by URL are downloaded by your machine. They are not copied through the server.

Inbox images are the exception. Bytes an assistant uploads, or that the server fetches from an image URL, sit in your account’s R2 bucket until the retention window above. After your Mac imports them, the local copy is the one you keep.

## Crash and error reporting

GatherOS does not currently collect crash reports or error logs automatically. If you hit a bug, the most helpful thing is to email us a description (and a screenshot if you can) at [hey@gatheros.co](mailto:hey@gatheros.co). If we ever introduce optional crash reporting in the future, it will be opt-in and disclosed clearly in this document.

## Children

GatherOS is not directed at children under 13. If you are a parent or guardian and believe your child has used GatherOS, contact us at [hey@gatheros.co](mailto:hey@gatheros.co).

## Changes to this policy

If we materially change how GatherOS handles data, we'll update this document, bump the "Last updated" date, and surface the change in the app's What's New release notes. The October 29, 2026 update adds the inbox and corrects the account and AI sections, which already used a server. The current version of this policy is always available inside the app at **Settings → About → Privacy policy**, and on GitHub at [`PRIVACY.md`](./PRIVACY.md).

## Contact

Questions, requests, or concerns: [hey@gatheros.co](mailto:hey@gatheros.co)
