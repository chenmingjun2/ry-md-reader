/**
 * Ry Markdown Reader — background service worker.
 *
 * Any top-level navigation to a Markdown file (by extension) is handed over to
 * the bundled viewer. The viewer keeps the original URL in `?src=...` and
 * fetches the document with the extension's host permissions.
 */

const VIEWER_URL = chrome.runtime.getURL('viewer.html');
const MARKDOWN_PATH = /\.(md|markdown|mdown|mkd)$/i;

/** URLs marked with this fragment are opened raw (no interception). */
const RAW_FRAGMENT = 'ry-raw';

function isMarkdownUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    return false;
  }
  if (parsed.hash === `#${RAW_FRAGMENT}`) return false;
  if (parsed.origin === new URL(VIEWER_URL).origin) return false;

  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path when it contains malformed escapes.
  }
  return MARKDOWN_PATH.test(pathname);
}

function viewerUrlFor(sourceUrl) {
  return `${VIEWER_URL}?src=${encodeURIComponent(sourceUrl)}`;
}

async function openMarkdown(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  if (!isMarkdownUrl(details.url)) return;

  try {
    await chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) });
  } catch {
    // The tab may have been closed or navigated elsewhere in the meantime.
  }
}

chrome.webNavigation.onBeforeNavigate.addListener(openMarkdown);

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: VIEWER_URL });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.tabs.create({ url: VIEWER_URL });
  }
});
