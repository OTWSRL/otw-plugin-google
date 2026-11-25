// The one piece of browser code in the plugin: it sends a file from the person's computer
// straight to Google, in pieces, to an address the server opened for that one file. Served by
// the plugin's own route and included only by the upload screens, so no other page carries it.
// The browser never holds a token: the address is all it is given.

/** The script, as text. Plain JavaScript without a build step, kept small. */
export const UPLOAD_SCRIPT = `(() => {
  const CHUNK = 8 * 1024 * 1024; // A multiple of 256 KB, as Google asks of every piece but the last.
  const RETRIES = 5;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error || 'The site refused the upload.');
    return answer;
  }

  /** Where Google has got to, from its answer to a piece or to a question about the upload. */
  function received(response, fallback) {
    const range = response.headers.get('range');
    const match = range && /bytes=0-(\\d+)/.exec(range);
    return match ? Number(match[1]) + 1 : fallback;
  }

  async function send(session, file, onProgress) {
    let offset = 0;
    let failures = 0;
    for (;;) {
      const end = Math.min(offset + CHUNK, file.size);
      let response;
      try {
        response = await fetch(session, {
          method: 'PUT',
          headers: { 'content-range': 'bytes ' + offset + '-' + (end - 1) + '/' + file.size },
          body: file.slice(offset, end),
        });
      } catch (error) {
        if (++failures > RETRIES) throw new Error('The connection kept dropping. Try again.');
        await wait(1000 * failures);
        // Ask Google how much arrived, and carry on from there.
        try {
          const asked = await fetch(session, { method: 'PUT', headers: { 'content-range': 'bytes */' + file.size } });
          if (asked.status === 308) offset = received(asked, 0);
          else if (asked.ok) return asked.json();
        } catch (again) {}
        continue;
      }
      if (response.status === 308) {
        failures = 0;
        offset = received(response, end);
        onProgress(offset);
        continue;
      }
      if (response.ok) {
        onProgress(file.size);
        return response.json().catch(() => ({}));
      }
      if (response.status >= 500 && ++failures <= RETRIES) {
        await wait(1000 * failures);
        continue;
      }
      throw new Error('Google refused the file (' + response.status + ').');
    }
  }

  const size = (bytes) => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1024 ** 2)) + ' MB';

  for (const form of document.querySelectorAll('form[data-google-upload]')) {
    if (form.dataset.ready) continue;
    form.dataset.ready = '1';
    const status = form.querySelector('[data-upload-status]');
    const bar = form.querySelector('progress');
    const button = form.querySelector('button[type="submit"]');
    const say = (text) => { if (status) status.textContent = text; };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.querySelector('input[type="file"]');
      const file = input && input.files && input.files[0];
      if (!file) return say('Choose a file first.');
      const fields = {};
      for (const [name, value] of new FormData(form)) if (typeof value === 'string') fields[name] = value;
      const leaving = (unload) => { unload.preventDefault(); unload.returnValue = ''; };
      try {
        button.disabled = true;
        say('Starting…');
        const opened = await post(form.dataset.open, { ...fields, name: file.name, bytes: file.size, type: file.type });
        if (bar) { bar.hidden = false; bar.max = file.size; bar.value = 0; }
        addEventListener('beforeunload', leaving);
        const started = Date.now();
        const result = await send(opened.url, file, (done) => {
          if (bar) bar.value = done;
          const seconds = (Date.now() - started) / 1000;
          const left = done > 0 ? Math.round((seconds * (file.size - done)) / done / 60) : 0;
          say('Uploading: ' + size(done) + ' of ' + size(file.size) + (left > 0 ? ', about ' + left + ' min left' : '') + '. Keep this tab open.');
        });
        removeEventListener('beforeunload', leaving);
        say('Finishing…');
        const done = await post(form.dataset.done, { ...fields, id: result && result.id });
        location.assign(done.redirect);
      } catch (error) {
        removeEventListener('beforeunload', leaving);
        button.disabled = false;
        say(error.message || 'The upload failed. Try again.');
      }
    });
  }
})();
`
