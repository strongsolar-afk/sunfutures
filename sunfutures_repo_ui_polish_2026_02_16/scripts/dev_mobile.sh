#!/usr/bin/env bash
set -euo pipefail
cd apps/mobile
npm install
npx expo run:ios
