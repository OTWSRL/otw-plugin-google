import {
  ActionError,
  type AdminActionContext,
  type AdminActionResult,
  type PluginContext,
} from '@otwdesign/sdk'
import {
  canSend,
  disconnectAccount,
  findAccount,
  findAnyAccount,
  setSendsMail,
  setSiteMail,
  siteMailAccount,
} from './accounts'
import { MANAGE } from './config'
import { MAIL_SERVICE } from './runtime'

// What the Accounts screen's buttons do. The CMS has already checked the post came from this
// site and that the person has the action's capability; each one still checks whose account it is.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const gone = () => new ActionError('That Google account isn’t connected any more.')

/** Where to ask Google for the permission to send, coming back to the accounts screen. */
const askToSend = (cms: PluginContext, accountId: string): AdminActionResult => ({
  redirect: `${cms.routes.apiUrl('/oauth/start')}?${new URLSearchParams({
    service: MAIL_SERVICE.id,
    account: accountId,
  })}`,
})

/** Disconnects one of the person's accounts, or anyone's for someone who manages the plugin. */
export async function disconnect(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const id = field(form, 'id')
  const account =
    (await findAccount(cms, user.id, id)) ??
    (cms.auth.can(user, MANAGE) ? await findAnyAccount(cms, id) : null)
  if (!account) throw gone()
  await disconnectAccount(cms, account)
  cms.logger.info('A Google account was disconnected', { account: account.id, by: user.id })
  return { notice: `${account.email} is disconnected. This site no longer has access to it.` }
}

/** The owner lets the site send email from their account, or stops it. */
async function sendsMail(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const account = await findAccount(cms, user.id, field(form, 'id'))
  if (!account) throw gone()
  const allowed = field(form, 'allowed') === '1'
  if (allowed && !canSend(account)) return askToSend(cms, account.id)
  if (!allowed && account.siteMail) {
    throw new ActionError('The site’s email goes out from this account. Choose another first.')
  }
  await setSendsMail(cms, user.id, account.id, allowed)
  return {
    notice: allowed
      ? `This site may now send email from ${account.email}.`
      : `This site no longer sends email from ${account.email}.`,
  }
}

/** Makes one of the administrator's own accounts the one the site's email goes out from. */
async function siteMail(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const account = await findAccount(cms, user.id, field(form, 'id'))
  if (!account) throw gone()
  if (account.state !== 'ok') throw new ActionError('Reconnect this account first.')
  if (!canSend(account)) return askToSend(cms, account.id)
  await setSendsMail(cms, user.id, account.id, true)
  await setSiteMail(cms, account.id)
  return { notice: `The site’s email now goes out from ${account.email}.` }
}

async function siteMailOff(cms: PluginContext): Promise<AdminActionResult> {
  await setSiteMail(cms, null)
  return { notice: 'No account is chosen for the site’s email now.' }
}

/** Sends a test email the way the site sends its own, and says what happened. */
async function testMail(
  cms: PluginContext,
  { form }: AdminActionContext,
): Promise<AdminActionResult> {
  const to = field(form, 'to')
  if (!EMAIL.test(to) || to.length > 254)
    throw new ActionError('Enter an email address to send to.')
  if (cms.settings.get('google.site_mail') !== true) {
    throw new ActionError(
      'Switch on “Send the site’s email through Gmail” under Settings › Google first.',
    )
  }
  if (!(await siteMailAccount(cms))) {
    throw new ActionError('Choose the account the site’s email goes out from first.')
  }
  const site = cms.settings.get('site.title') || 'this site'
  const sent = await cms.mail.send({
    to,
    subject: `A test email from ${site}`,
    text: `This is a test email from ${site}, sent through Gmail by the Google plugin.`,
  })
  if (!sent) throw new ActionError('The test email couldn’t be sent. The server log says why.')
  return { notice: `A test email is on its way to ${to}.` }
}

export {
  sendsMail as 'sends-mail',
  siteMail as 'site-mail',
  siteMailOff as 'site-mail-off',
  testMail as 'test-mail',
}
