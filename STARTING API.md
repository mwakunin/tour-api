#### USING API IN DOCKER

### Initial build for api

docker compose build

### Then script for containers

pnpm run dev:docker

### After any changes to dependences or dockerfile

# Rebuild only the api service

docker compose build api

# Restart only the api container

docker compose up -d api

### In Production

pnpm run db:migrate:production

### Verify test tables

docker exec -it footloose-postgres psql -U postgres -d footloose_test -c "\dt"

### Verify dev tables

docker exec -it footloose-postgres psql -U postgres -d footloose_dev -c "\dt"

#### USING API LOCALLY

## Set Up

# Start databases

docker compose up -d postgres redis

# Migrate

pnpm run db:migrate
NODE_ENV=test pnpm run db:migrate

# Run api locally

pnpm dev

## Daily use

# Start

docker compose start postgres redis

# Stop (keeps containers, preserves data)

docker compose stop

## After changes to tables

pnpm run db:migrate
NODE_ENV=test pnpm run db:migrate

## NB

# Up (creates and starts containers)

docker compose up -d postgres redis

# Down (removes containers but keeps volumes/data)

docker compose down
