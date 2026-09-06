#!/bin/bash
echo "🚀 Starting Footloose Adventures Dev Environment..."

docker compose up -d
echo "⏳ Waiting for postgres..."
until docker compose exec postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

pnpm run db:migrate                  # migrates footloose_dev
NODE_ENV=test pnpm run db:migrate    # migrates footloose_test

echo "✅ Dev environment ready. Tailing API logs (Ctrl+C to stop tailing, containers keep running)..."
docker compose logs -f api
