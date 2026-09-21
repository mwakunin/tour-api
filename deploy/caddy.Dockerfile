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
#
# EVERYTHING IS PINNED, deliberately. xcaddy builds the latest Caddy core when
# given no version, and an unpinned --with resolves the module's newest ref --
# so a rebuild months later could ship an ingress binary nobody ever ran,
# changed by nothing visible in this repo. The base images are pinned to the
# same core version for the same reason. Upgrading is an act: bump the three
# versions below together, rebuild, and re-verify (`caddy validate` plus a
# real certificate issuance) before it takes traffic.

FROM caddy:2.10.2-builder-alpine AS builder

RUN xcaddy build v2.10.2 \
    --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.10.2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
