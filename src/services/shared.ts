import type { PluginContext, User } from '@otwdesign/sdk'
import { allows, listAccounts, type GoogleAccount } from '../accounts'
import type { GoogleService } from '../config'
import { serviceOf } from '../runtime'

// What every service's screens, actions and API routes start with: which of the person's
// accounts may use the service, and which one this request is about. No component lives here:
// API routes import this file, and what they import must bring no browser code with it.

export interface ServiceAccounts {
  service: GoogleService
  /** Every account the person connected, with whether it may use the service now. */
  accounts: { account: GoogleAccount; usable: boolean }[]
  /** The account this screen shows: the one asked for when it's usable, else the first that is. */
  current: GoogleAccount | null
}

const usable = (account: GoogleAccount, service: GoogleService) =>
  account.state === 'ok' && allows(account, service)

/** A person's accounts for a service, and the one `asked` names (an account id from the address). */
export async function serviceAccounts(
  cms: PluginContext,
  user: User,
  serviceId: string,
  asked: string | undefined,
): Promise<ServiceAccounts | null> {
  const service = serviceOf(cms, serviceId)
  if (!service) return null
  const accounts = (await listAccounts(cms, user.id)).map((account) => ({
    account,
    usable: usable(account, service),
  }))
  const current =
    accounts.find((entry) => entry.usable && entry.account.id === asked)?.account ??
    accounts.find((entry) => entry.usable)?.account ??
    null
  return { service, accounts, current }
}

/**
 * The account a form or a request names, when it's the person's and may use the service: for
 * actions and API routes, which must not fall back to another account.
 */
export async function requireAccount(
  cms: PluginContext,
  user: User,
  serviceId: string,
  accountId: string,
): Promise<GoogleAccount | null> {
  const found = await serviceAccounts(cms, user, serviceId, accountId)
  return found?.current?.id === accountId ? found.current : null
}
