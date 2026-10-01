/* ---------------------------------------------------------------------------
 * Where the API lives.
 *
 * EDIT THE ONE LINE BELOW after you deploy the API, then commit and push.
 *
 * The public pages are static files on GitHub Pages; the database and the login
 * live on a separate Node host. This tells the pages which host to ask.
 *
 *   API_BASE = ""      same origin. THIS IS THE SETTING FOR THIS SITE: Azure
 *                      App Service serves the pages and the API together, and
 *                      so does a local `npm run dev`. Leave it empty.
 *
 *   API_BASE = "https://cvlab-jnu-a6gq....centralindia-01.azurewebsites.net"
 *                      only for the split deployment, where these pages are
 *                      published to GitHub Pages and the API lives elsewhere.
 *                      Copy the host from the portal (Overview -> Default
 *                      domain); new Azure apps carry a random hash in it.
 *                      No trailing slash.
 *
 * If you use the GitHub Actions workflow in .github/workflows/pages.yml, it
 * rewrites this value at deploy time from the CVLAB_API_BASE repository
 * variable, so you can leave the placeholder here and never commit the URL.
 * ------------------------------------------------------------------------- */

window.CVLAB_CONFIG = {
  API_BASE: '',

  /* A free API host stops the process when idle and starts it again on the next
   * request, which can take up to a minute. The pages show a "waking" notice and
   * retry rather than reporting an error. Set to 0 to disable retrying. */
  COLD_START_RETRIES: 4,
  COLD_START_DELAY_MS: 4000,
};
