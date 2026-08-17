#!/bin/sh
# Materializes the SPA's runtime configuration at container start.
#
# The SPA is static, so its API base URL and sign-in settings must not be baked in at build
# time – otherwise one image per environment is the result and S13 pays for it. This writes
# config.js from the environment on every start, so the same image serves any environment.
#
# EVERYTHING WRITTEN HERE IS PUBLIC. The browser downloads this file. A client ID and a hosted
# domain belong here – neither is a secret. GOOGLE_WEB_CLIENT_SECRET must never be added: the
# API holds it and brokers the code exchange precisely so it never reaches a browser.
set -eu

: "${API_BASE_URL:=/api}"
: "${GOOGLE_WEB_CLIENT_ID:=}"
: "${GOOGLE_HOSTED_DOMAIN:=}"
: "${GOOGLE_REDIRECT_URI:=}"

cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFAPP_CONFIG__ = {
  apiBaseUrl: "${API_BASE_URL}",
  auth: {
    clientId: "${GOOGLE_WEB_CLIENT_ID}",
    hostedDomain: "${GOOGLE_HOSTED_DOMAIN}",
    redirectUri: "${GOOGLE_REDIRECT_URI}"
  }
};
EOF

echo "runtime-config: apiBaseUrl=${API_BASE_URL} clientId=${GOOGLE_WEB_CLIENT_ID:-(unset)}"
