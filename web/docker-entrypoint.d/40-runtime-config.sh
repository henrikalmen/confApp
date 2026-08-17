#!/bin/sh
# Materializes the SPA's runtime configuration at container start.
#
# The SPA is static, so its API base URL must not be baked in at build time – otherwise one
# image per environment is the result and S13 pays for it. This writes config.js from the
# environment on every start, so the same image serves any API base URL.
set -eu

: "${API_BASE_URL:=/api}"

cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFAPP_CONFIG__ = { apiBaseUrl: "${API_BASE_URL}" };
EOF

echo "runtime-config: apiBaseUrl=${API_BASE_URL}"
