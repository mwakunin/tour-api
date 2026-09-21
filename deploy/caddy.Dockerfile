# Caddy with the Cloudflare DNS provider built in.
#
# WHY A CUSTOM IMAGE IS NEEDED AT ALL
#
# The stock caddy:2-alpine answers the ACME HTTP-01 challenge, which is why
# deploy/Caddyfile is nine lines and there is no certbot cron. HTTP-01 cannot
# issue a WILDCARD certificate -- Let's Encrypt only issues those through
# DNS-01, which means proving control by writing a TXT record at
# _acme-challenge.<domain>. Caddy can do that, but only with a DNS provider
# module compiled in, and modules are compile-time in Go.
#
# So: needed only for per-operator hostnames (*.api.example.com). A
# single-host deployment should keep using caddy:2-alpine and Caddyfile.
#
# Swap caddy-dns/cloudflare for another provider if DNS moves; the Caddyfile's
# `dns` directive changes name with it.

FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
