// Runs the tests' stand-in for Google (test/fake-google.mjs) on a port, for the browser tests:
// the site's requests to Google go here, and so does the browser, for the consent screen and
// for the uploads it sends itself.
import { fakeDrive } from '../../test/fake-drive.mjs'
import { startFakeGoogle } from '../../test/fake-google.mjs'
import { fakeYouTube } from '../../test/fake-youtube.mjs'

const port = Number(process.env.FAKE_GOOGLE_PORT ?? 3511)
const fake = await startFakeGoogle({ port, routes: [fakeYouTube, fakeDrive] })
console.log(`The stand-in for Google listens on ${fake.url}`)
