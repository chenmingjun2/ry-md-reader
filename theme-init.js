/* Applies the saved theme before first paint. Light is the default. */
(() => {
  let theme = 'light';
  try {
    if (localStorage.getItem('ry-md-theme') === 'dark') theme = 'dark';
  } catch {
    // Storage can be unavailable in rare browser configurations.
  }
  document.documentElement.dataset.theme = theme;
})();
