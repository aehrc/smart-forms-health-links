# The BFF serves the built SPA, so development watches a real build rather than running Vite's
# dev server on a second port. The session is a cookie on one origin, and the redirect URI
# registered with the authorisation server points at the BFF, so a proxied SPA on another port
# would sign you in on an origin you are not looking at. The trade-off is rebuild-on-save instead
# of hot module replacement.
web: npm run build -- --watch
server: npm run dev:server
