#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# 1. Generate the client FIRST so TypeScript can see the types
npx prisma generate

# 2. NOW run the build (tsc)
npm run build

# 3. Run migrations (Optional: verify your Render build environment has access to DATABASE_URL)
npx prisma migrate deploy