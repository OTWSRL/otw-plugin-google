import {
  ActionError,
  type PluginContext,
  type SignInIdentity,
  type SignInProviderRequest,
} from '@otwdesign/sdk'
import { IDENTITY_SCOPES } from './config'
import { GoogleError, readIdToken, requestToken } from './google'
import { consentUrl } from './oauth'
import { requireClient } from './runtime'
import { domainsOf } from './settings'

// "Continue with Google": core owns the state, the session and the account; this says where to
// send the person, and who came back.

const GMAIL = /@(?:gmail|googlemail)\.com$/

const allowedDomains = (cms: PluginContext): string[] =>
  domainsOf(cms.settings.get('google.domains')) ?? []

/** Google's address to send someone to who wants to sign in: their identity, nothing more. */
export function startSignIn(cms: PluginContext, request: SignInProviderRequest): string {
  const domains = allowedDomains(cms)
  return consentUrl(requireClient(cms), {
    redirectUri: request.redirectUri,
    state: request.state,
    verifier: request.verifier,
    scopes: IDENTITY_SCOPES,
    offline: false,
    // A hint for Google's account chooser. The check that counts is on the way back.
    hostedDomain: domains.length === 1 ? domains[0] : undefined,
  })
}

/** Who came back from Google, from the code it sent with them. */
export async function finishSignIn(
  cms: PluginContext,
  request: SignInProviderRequest & { params: URLSearchParams },
): Promise<SignInIdentity> {
  const code = request.params.get('code')
  if (request.params.get('error') === 'access_denied') {
    throw new ActionError('You didn’t allow it at Google, so you aren’t signed in.')
  }
  if (request.params.get('error') || !code) {
    throw new ActionError('Google couldn’t sign you in. Try again.')
  }
  const client = requireClient(cms)
  let identity
  try {
    const grant = await requestToken(client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
    })
    identity = readIdToken(grant.idToken, client.id)
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    cms.logger.warn('A Google sign-in failed', { kind: error.kind, status: error.status })
    throw new ActionError('Google couldn’t sign you in. Try again.')
  }
  const domains = allowedDomains(cms)
  const domain = identity.email.slice(identity.email.lastIndexOf('@') + 1)
  if (domains.length > 0 && !(identity.emailVerified && domains.includes(domain))) {
    throw new ActionError('Only some organisations’ Google accounts can sign in here.')
  }
  return {
    subject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    // Google hosts the mailbox of a gmail.com address and of a Workspace account, so it speaks
    // for who owns it today. Other addresses it only checked once.
    emailOwned:
      identity.emailVerified && (identity.hostedDomain !== null || GMAIL.test(identity.email)),
    name: identity.name,
  }
}
