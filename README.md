# Google for OTW CMS

Sign in with Google, and each person's own YouTube, Drive and Gmail in the admin. The site's
email can go out through a connected Gmail account, so a small site needs no mail plugin beside
it.

- **Accounts**: a person connects one or more Google accounts to their own CMS account. Each
  service asks Google for its own permission the first time it's allowed, never all at once.
- **Continue with Google**: on the admin's sign-in page and on the account page. Someone new can
  get an account, with a role that opens the Google screens and nothing else.
- **YouTube**: the channel's videos, their details and visibility, playlists, and uploads that go
  from the browser straight to YouTube.
- **Drive**: folders and files, search, the trash, downloads and previews, uploads from the
  browser straight to Drive, and copies into the Media library.
- **Gmail**: labels, threads, search, reading, writing, replying, drafts and attachments.
- **The site's email**: `cms.mail.send()` goes out through Gmail when you say so.
- **More services**: each is an entry in a registry. Calendar and the rest are added the same way.

## Install

```sh
npx cms plugin add @otwdesign/plugin-google
```

or from the admin, **Plugins › Add Plugin**. It needs OTW CMS 1.10 or later. Activate **Google**
on the Plugins screen.

## Set up Google

You bring your own Google client: each site is its own "app" at Google.

1. In the [Google Cloud console](https://console.cloud.google.com/), make a project, and enable
   the APIs you'll use: **YouTube Data API v3**, **Google Drive API**, **Gmail API**.
2. Under **Google Auth Platform**, set up the consent screen. Choose **Internal** if everyone who
   connects is in your Google Workspace organisation; otherwise **External**.
3. Under **Clients**, create an OAuth client of the type **Web application**. Add the two
   redirect addresses that **Google › Accounts** shows in its Setup box:
   - `https://your-site/api/p/google/oauth/callback` (connecting accounts)
   - `https://your-site/api/p/core/sign-in/google/callback` (Continue with Google)
4. Put the client's ID under **Google › Settings**, and its secret in the site's environment:

```sh
GOOGLE_CLIENT_SECRET=…
```

Set **Settings › General › Site address** too, so the addresses the site gives Google are exact
whatever the request arrived on.

| Variable               | What it is                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_SECRET` | The OAuth client's secret. Read from the environment only: never stored, never shown.                      |
| `GOOGLE_CLIENT_ID`     | Optional: the client's ID, instead of typing it under Google › Settings.                                   |
| `GOOGLE_TOKEN_KEY`     | Optional: a long random string that encrypts the stored tokens. Without it, the key comes from the secret. |
| `GOOGLE_API_URL`       | For tests only: an address that stands in for Google's servers. Never set it on a live site.               |

Changing the client secret (or `GOOGLE_TOKEN_KEY`, when set) makes the stored tokens unreadable:
every account then says "Needs reconnecting". Set `GOOGLE_TOKEN_KEY` once if you expect to
rotate the client secret.

## Google's limits

These are Google's rules for your client, not the plugin's:

- While the client is in **Testing**, Google ends every connection after 7 days and lets at most
  100 people connect. Signing in alone (no service connected) isn't limited.
- **In production**, YouTube needs Google's verification. Gmail and Drive, for people outside
  your own organisation, also need Google's yearly security assessment.
- An **Internal** client (Google Workspace) has none of these limits, for people in that
  organisation.
- YouTube gives each project a daily quota. A plain page of the video list costs 3 units; a
  search costs 100 more.

## Who can do what

| Capability      | Who has it                               | What it allows                                                        |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `google.use`    | The roles ticked under Google › Settings | Connect their own Google accounts and use the services with them      |
| `google.manage` | Administrators                           | The settings, the Setup box, and seeing and disconnecting any account |

An account is used only by the person who connected it. An administrator sees that someone's
account exists and can disconnect it; nobody but its owner can read its mail, files or videos.
One Google account belongs to one person on a site.

The role **Google user** has `core.access_admin` and `google.use`: the Google screens and their
own profile.

## Signing in with Google

- The button asks Google for `openid email profile` only, and keeps no token.
- A person is found by Google's own id for them once they've signed in or connected.
- An address joins the account that already has it only when Google hosts the mailbox: a
  gmail.com address, or one in a Google Workspace domain. For any other address, sign in with
  the password once and connect the Google account; after that the button works.
- A sign-in step (two-step sign-in) still asks for its code afterwards.
- **Only these domains** limits who can sign in; **Someone new gets an account** decides whether
  a stranger gets one.

## The site's email

Tick **Send the site's email through Gmail** under Google › Settings, then choose the account
with **Use for the site's email** on one of your own accounts under Google › Accounts. It asks
Google for the permission to send, nothing more.

- Gmail sends only as the account itself, so the sender's address is the account's. The name the
  site gave its sender stays in front of it.
- A message whose sender is the address of another connected account goes out from that account,
  but only when its owner switched on **Let the site send email from it**.
- Only one plugin sends a site's email. With [Mailer](https://github.com/OTWSRL/otw-mailer)
  active, Mailer does, whatever this setting says.
- Gmail limits sending: about 500 recipients a day for a free account, 2,000 for Workspace.

## What it costs a site

Installed and active, the plugin loads its small definition file and nothing else until someone
uses it:

- **Site pages**: the same HTML, JavaScript and CSS as without the plugin. No request, no query.
- **Other admin screens**: the same, plus the menu entry for people who may use Google.
- **Sign-in pages**: one link, with no script, while Continue with Google is on.
- **The server**: each service's code is imported the first time its screen or route is used.
- **The browser**: the plugin's only script is the uploader, which the two upload screens fetch.

`test/lazy.test.ts` holds the plugin to this: it fails if the main entry or the admin entry
imports anything but names.

## Security

- **The client secret and the token key come from the environment only.**
- **Tokens are encrypted** (AES-256-GCM) in the database, each bound to its row and column, so a
  value copied elsewhere doesn't open. A token never reaches a browser, a page or a log.
- **Uploads**: the server opens the upload at Google and hands the browser the address for that
  one file. The browser never holds a token.
- **Connecting**: a signed cookie ties the way back from Google to the browser and the person
  that left, with PKCE. A way back sent to someone else does nothing.
- **Email HTML** is shown in a sandboxed frame from an address with its own
  `Content-Security-Policy`, after being reduced to an allow-list of tags. Remote images stay off
  until asked for.
- **Files from Drive** are served as downloads, or inline only for images, audio, video, PDF and
  plain text, with `nosniff` and a sandbox.
- **Nothing from Google is stored**: mail, files and videos are read from Google when shown.

## Deleting its data

**Delete Data** on the Plugins screen drops the plugin's table and the record of who signs in
with Google. It can't tell Google: disconnect the accounts first (Google › Accounts,
**Everyone's**), or remove the site under each Google account's security settings.

## For developers

### Requests to Google from another plugin

```ts
import type {} from '@otwdesign/plugin-google'

const google = cms.services.get('google')
const [account] = await google.accounts(user.id)
const response = await google.fetch(
  user.id,
  account.id,
  'https://www.googleapis.com/calendar/v3/users/me/calendarList',
)
```

The token is added and renewed for you, and never handed over. An account that isn't the
user's is refused.

### Adding a service

Add an entry to the `google.services` registry in your plugin's `setup()`:

```ts
cms.registries.get('google.services').add({
  id: 'calendar',
  label: 'Calendar',
  asks: 'see and edit your calendars',
  scopes: ['https://www.googleapis.com/auth/calendar'],
  enabled: () => true,
})
```

The Accounts screen then offers **Allow Calendar**, and the service's scopes are asked for with
the person's consent. Your screens send their requests with `cms.services.get('google').fetch()`.

## Development

The plugin is the repo's root package; `site/` is the OTW site it's tested on. The CMS's packages
are linked from a checkout next to this repo (`../nextjs-cms`).

```sh
pnpm install
pnpm test:all   # lint, format, types, unit tests, then the browser tests
```

The tests run against a stand-in for Google (`test/fake-google.mjs`), which speaks Google's OAuth
and the parts of its APIs the plugin uses. Nothing in the tests reaches Google.
