import type { OutgoingMail, PluginContext } from '@otwdesign/sdk'
import { canSend, googleJson, senderAccount, siteMailAccount, type GoogleAccount } from './accounts'
import { googleUrl } from './google'
import { rawMime, splitAddress } from './mime'

// The site's email through Gmail: `cms.mail.send()` ends here when Settings › Google says so.

/** Gmail's address for sending as the signed-in account. */
export const SEND_URL = () => googleUrl('gmail.googleapis.com', '/gmail/v1/users/me/messages/send')

/**
 * The account a message goes out from: one its sender names, when that account's owner lets the
 * site send from it, else the one chosen for the site's email.
 */
async function accountFor(cms: PluginContext, from: string | null): Promise<GoogleAccount> {
  const named = from ? await senderAccount(cms, splitAddress(from).address) : null
  const account = named ?? (await siteMailAccount(cms))
  if (!account) {
    throw new Error('No Google account is chosen for the site’s email, under Google › Accounts')
  }
  if (account.state !== 'ok') throw new Error(`${account.email} needs connecting to Google again`)
  if (!canSend(account)) throw new Error(`${account.email} hasn’t allowed sending email`)
  return account
}

/**
 * Sends one of the site's messages. Gmail sends only as the account itself, so the sender's
 * address is the account's; the name the site gave its sender stays in front of it.
 */
export async function sendSiteMail(cms: PluginContext, message: OutgoingMail): Promise<void> {
  const account = await accountFor(cms, message.from)
  const name = message.from ? splitAddress(message.from).name : ''
  await googleJson(cms, account.userId, account.id, SEND_URL(), {
    method: 'POST',
    json: {
      raw: rawMime({
        from: name ? `${name} <${account.email}>` : account.email,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    },
  })
}
