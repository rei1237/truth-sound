// Public weights are immutable. Only model downloads leave the site; audio stays in the worker.
export const modelBase = location.hostname === 'rei1237.github.io'
  ? 'https://raw.githubusercontent.com/rei1237/truth-sound/b744f6dcd74d6b0bc9c4f2f3c23da4f847f36533/web/models/'
  : new URL('./models/',import.meta.url).href;

