/**
 * The page that shows Google's own Drive browser, and the reply it sends back.
 *
 * Both halves are pure functions of their inputs, which is the point: the Picker
 * itself cannot be exercised without a Google account, but "does the page carry the
 * four values the Picker needs" can be — and a Picker missing one of them does not
 * fail when it opens. It fails later, on the write, which is the worst possible
 * moment to discover it.
 */

/** The path the picker page navigates to once the user has chosen. */
export const PICKED_PATH = '/picked'

export interface PickedFolder {
  id: string
  name: string
}

/**
 * What came back from the picker page.
 *
 * Cancelling is not an error: closing the picker without choosing should leave the
 * folder exactly as it was and say nothing, so the caller needs to tell that apart
 * from a failure.
 */
export function parsePicked(
  query: URLSearchParams
): { folder: PickedFolder } | { cancelled: true } | { error: string } {
  if (query.get('cancel') !== null) return { cancelled: true }
  const error = query.get('error')
  if (error !== null) return { error }
  const id = query.get('id')
  if (id === null || id === '') return { error: 'no folder in the reply' }
  return { folder: { id, name: query.get('name') ?? id } }
}

/**
 * The picker page.
 *
 * Served over loopback rather than from a file, because the Picker refuses to run on
 * a `file://` origin. `setAppId` is the load-bearing one: it is what tells Google
 * which application the user is granting access to, and without it a folder picked
 * under the `drive.file` scope is picked for nobody — the app still cannot write
 * into it.
 *
 * Values go in through `JSON.stringify`, so a token or a name containing a quote
 * cannot end the string it sits in.
 */
export function pickerPage(config: {
  accessToken: string
  apiKey: string
  appId: string
  title: string
  waiting: string
}): string {
  /*
    JSON, with `<` escaped as well.

    `JSON.stringify` alone is not enough for a value going inside an inline
    <script>: the HTML parser looks for the closing tag before JavaScript ever sees
    the string, so a value containing </script> ends the script block early and
    whatever followed becomes markup. Escaping `<` to < means the sequence
    cannot occur, and the JavaScript string is unchanged.
  */
  const value = (raw: string): string => JSON.stringify(raw).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(config.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0d12; color: #e8e8ea;
         display: grid; place-items: center; height: 100vh; margin: 0 }
  p { font-size: .85rem; color: #9b9ba3 }
</style></head>
<body>
  <p>${escapeHtml(config.waiting)}</p>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    var TOKEN = ${value(config.accessToken)};
    var KEY = ${value(config.apiKey)};
    var APP_ID = ${value(config.appId)};

    function go(query) { window.location.href = ${value(PICKED_PATH)} + query }

    function show() {
      var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');
      var picker = new google.picker.PickerBuilder()
        .setOAuthToken(TOKEN)
        .setDeveloperKey(KEY)
        .setAppId(APP_ID)
        // Stated explicitly: the Picker infers the origin, and infers it wrongly on
        // a loopback host often enough that saying it is cheaper than debugging it.
        .setOrigin(window.location.protocol + '//' + window.location.host)
        .addView(view)
        .setTitle(${value(config.title)})
        .setCallback(function (data) {
          if (data.action === google.picker.Action.PICKED) {
            var doc = data.docs && data.docs[0];
            if (!doc) { go('?error=' + encodeURIComponent('nothing was selected')); return }
            go('?id=' + encodeURIComponent(doc.id) + '&name=' + encodeURIComponent(doc.name || ''))
          } else if (data.action === google.picker.Action.CANCEL) {
            go('?cancel=1')
          }
        })
        .build();
      picker.setVisible(true)
    }

    if (window.gapi && window.gapi.load) {
      gapi.load('picker', { callback: show })
    } else {
      // api.js did not load at all — offline, or blocked. Say so instead of leaving
      // an empty window open with no explanation.
      go('?error=' + encodeURIComponent('Google could not be reached'))
    }
  </script>
</body></html>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
